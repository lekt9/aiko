use super::types::WebSearchConfig;
use crate::attribution::{SharedAttributionCallback, ToolConsumer};
use crate::types::SharedApiKeyProvider;
use async_openai::types::responses as rs;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
/// Which transport this endpoint can actually serve, learned from its own
/// answers rather than assumed.
///
/// `web_search` was Responses-API-only. An endpoint that rejects `/responses`
/// (or accepts it but refuses hosted tools) made the tool fail on every call
/// with no path to a result, even while its chat-completions endpoint worked
/// perfectly. Probing once and remembering keeps the good case at exactly one
/// request and stops the bad case from paying a doomed round-trip per search.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Backend {
    /// Not yet determined — try Responses, fall back on a refusal.
    Unknown = 0,
    /// Hosted web search over the Responses API.
    Responses = 1,
    /// Retrieve results ourselves, synthesize over chat completions.
    Retrieval = 2,
    /// The endpoint is an OpenAI-compatible router that performs the search
    /// itself when asked, returning sources as message `annotations`. One call
    /// instead of retrieve-then-synthesize, and the citations come from the
    /// search provider rather than from our own parsing.
    RouterPlugin = 3,
}

impl Backend {
    fn from_u8(raw: u8) -> Self {
        match raw {
            3 => Self::RouterPlugin,
            1 => Self::Responses,
            2 => Self::Retrieval,
            _ => Self::Unknown,
        }
    }
}

/// A minimal, purpose-built HTTP client for calling the Responses API
/// with web search capability.
#[derive(Clone)]
pub struct WebSearchClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    api_key_provider: Option<SharedApiKeyProvider>,
    /// Shared across clones so the probe result is learned once per session.
    backend: std::sync::Arc<std::sync::atomic::AtomicU8>,
    /// Optional JSON SERP endpoint for the retrieval backend; `None` uses the
    /// keyless default so the fallback needs no configuration to work.
    serp_url: Option<String>,
    serp_api_key: Option<String>,
    /// Optional 401-attribution hook. Callers can wire this so a 401
    /// from the Responses API emits an `auth_401_attribution` event
    /// with `consumer == "WebSearch"`.
    attribution_callback: Option<SharedAttributionCallback>,
}
impl WebSearchClient {
    /// Create a new web search client from `WebSearchConfig::Enabled`.
    ///
    /// Returns `Err` if the config is `Disabled` or if header values are invalid.
    pub fn new(
        config: &WebSearchConfig,
        api_key_provider: Option<SharedApiKeyProvider>,
    ) -> Result<Self, xai_tool_runtime::ToolError> {
        let WebSearchConfig::Enabled {
            api_key,
            base_url,
            model,
            extra_headers,
            alpha_test_key,
        } = config
        else {
            return Err(xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                "Cannot create WebSearchClient from disabled config".to_string(),
            ));
        };
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid API key for header: {e}"),
                )
            })?,
        );
        for (key, value) in extra_headers {
            let header_name = HeaderName::from_bytes(key.as_bytes()).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid header name '{key}': {e}"),
                )
            })?;
            let header_value = HeaderValue::from_str(value).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid header value for '{key}': {e}"),
                )
            })?;
            headers.insert(header_name, header_value);
        }
        let _ = alpha_test_key;
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Failed to build HTTP client: {e}"),
                )
            })?;
        Ok(Self {
            http,
            base_url: base_url.clone(),
            model: model.clone(),
            api_key_provider,
            backend: std::sync::Arc::new(std::sync::atomic::AtomicU8::new(Backend::Unknown as u8)),
            serp_url: std::env::var("AIKO_WEB_SEARCH_SERP_URL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            serp_api_key: std::env::var("AIKO_WEB_SEARCH_SERP_API_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            attribution_callback: None,
        })
    }

    fn backend(&self) -> Backend {
        Backend::from_u8(self.backend.load(std::sync::atomic::Ordering::Relaxed))
    }

    fn remember_backend(&self, backend: Backend) {
        self.backend
            .store(backend as u8, std::sync::atomic::Ordering::Relaxed);
    }
    /// Wire a 401-attribution callback into this client. Idempotent;
    /// safe to call before or after the first request.
    pub fn with_attribution_callback(
        mut self,
        callback: Option<SharedAttributionCallback>,
    ) -> Self {
        self.attribution_callback = callback;
        self
    }
    async fn current_bearer(&self) -> Option<String> {
        crate::types::api_key_provider::resolve_bearer(self.api_key_provider.as_ref()).await
    }
    fn record_401_attribution(&self, sent_bearer: Option<&str>) {
        crate::attribution::emit_401(
            self.attribution_callback.as_ref(),
            ToolConsumer::WebSearch,
            sent_bearer,
        );
    }
    /// Perform a web search query.
    ///
    /// Returns `(content, citations)` where content is the answer text and
    /// citations are the unique source URLs behind it.
    pub async fn search(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<String>), xai_tool_runtime::ToolError> {
        let (content, pairs) = self.search_with_titles(query, allowed_domains).await?;
        Ok((content, pairs.into_iter().map(|(_, url)| url).collect()))
    }

    /// True when a failure means "this endpoint does not do hosted web search
    /// over the Responses API" rather than "this request went wrong".
    ///
    /// Only the first kind may trigger the retrieval fallback. An auth failure
    /// or a rate limit must surface as itself — silently switching backends on
    /// a 401 would turn a fixable credential problem into a mysterious change
    /// in result quality.
    fn indicates_no_hosted_search(status: reqwest::StatusCode, body: &str) -> bool {
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND
                | reqwest::StatusCode::METHOD_NOT_ALLOWED
                | reqwest::StatusCode::NOT_IMPLEMENTED
        ) {
            return true;
        }
        if status != reqwest::StatusCode::BAD_REQUEST {
            return false;
        }
        let body = body.to_ascii_lowercase();
        [
            "not the responses api",
            "hosted_tools_not_supported",
            "hosted tool",
            "model_not_allowed",
            "is not allowed on this gateway",
            "unsupported",
        ]
        .iter()
        .any(|marker| body.contains(marker))
    }

    /// Ask an OpenAI-compatible router to do the search itself.
    ///
    /// Routers in the OpenRouter lineage accept a `plugins: [{"id": "web"}]`
    /// member on an ordinary `/chat/completions` call: they retrieve, ground
    /// the answer, and return the sources as `choices[].message.annotations[]`
    /// of type `url_citation`. That is strictly better than retrieving and
    /// synthesizing separately — one round trip, and the citations come from
    /// the search provider instead of our own HTML parsing.
    ///
    /// Verified by BEHAVIOUR, not by belief: an endpoint that ignores the
    /// plugin answers 200 with no annotations, which is indistinguishable from
    /// an ungrounded reply, so a response without annotations is treated as
    /// "this router does not do that" and falls through to retrieval. Nothing
    /// here trusts that the member was honoured.
    async fn router_plugin_search(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<Option<(String, Vec<(String, String)>)>, xai_tool_runtime::ToolError> {
        let mut plugin = serde_json::json!({ "id": "web", "max_results": 8 });
        if let Some(domains) = allowed_domains.as_ref().filter(|d| !d.is_empty()) {
            // Fold the domain filter into the query the plugin runs; the plugin
            // member itself has no portable allow-list field.
            plugin["search_prompt"] = serde_json::Value::String(format!(
                "Search only these domains: {}",
                domains.join(", ")
            ));
        }
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 2048,
            "plugins": [plugin],
            "messages": [{ "role": "user", "content": query }],
        });
        let sent_bearer = self.current_bearer().await;
        let mut request = self.http.post(&url).json(&body);
        if let Some(ref key) = sent_bearer {
            request = request.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = request.send().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Router search request failed: {e}"),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(sent_bearer.as_deref());
        }
        if !status.is_success() {
            // A router that rejects the plugin member, or cannot serve this
            // model, is simply not this backend. Say so at debug volume and let
            // the caller fall through — this is not the user's error.
            let detail = response.text().await.unwrap_or_default();
            tracing::debug!(%status, detail = %detail, "router web plugin unavailable");
            return Ok(None);
        }
        let payload: serde_json::Value = response.json().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to parse router response: {e}"),
            )
        })?;
        Ok(parse_router_annotations(&payload))
    }

    /// Retrieve results ourselves, then synthesize over chat completions —
    /// the path for endpoints that answer chat but not hosted search.
    async fn retrieval_search(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), xai_tool_runtime::ToolError> {
        let engine_query = super::serp::build_query(query, allowed_domains.as_deref());
        let results = super::serp::search(
            &engine_query,
            self.serp_url.as_deref(),
            self.serp_api_key.as_deref(),
        )
        .await?;
        if results.is_empty() {
            return Ok(("No search results found.".to_string(), Vec::new()));
        }
        let pairs: Vec<(String, String)> = results
            .iter()
            .map(|result| (result.title.clone(), result.url.clone()))
            .collect();
        let content = self
            .synthesize_over_results(query, &super::serp::render_for_synthesis(&results))
            .await
            // Retrieval already succeeded; a synthesis failure must not discard
            // the sources. Hand back the raw hits rather than nothing.
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "web search synthesis failed; returning raw results");
                super::serp::render_for_synthesis(&results)
            });
        Ok((content, pairs))
    }

    /// Ask the ordinary chat-completions endpoint to answer over the retrieved
    /// sources. No tools involved — this is the endpoint's plain path, which is
    /// exactly why it is available when the hosted-tool path is not.
    async fn synthesize_over_results(
        &self,
        query: &str,
        sources: &str,
    ) -> Result<String, xai_tool_runtime::ToolError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "temperature": 0.1,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "system",
                    "content": "Answer the query using ONLY the numbered search results provided. \
                                Cite sources inline as [n]. If the results do not answer the \
                                query, say so plainly rather than filling the gap from memory.",
                },
                {
                    "role": "user",
                    "content": format!("Query: {query}\n\nSearch results:\n{sources}"),
                },
            ],
        });
        let sent_bearer = self.current_bearer().await;
        let mut request = self.http.post(&url).json(&body);
        if let Some(ref key) = sent_bearer {
            request = request.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = request.send().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Synthesis request failed: {e}"),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(sent_bearer.as_deref());
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Synthesis endpoint returned {status}: {body}"),
            ));
        }
        let payload: serde_json::Value = response.json().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to parse synthesis response: {e}"),
            )
        })?;
        payload
            .pointer("/choices/0/message/content")
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    "Synthesis response carried no content".to_string(),
                )
            })
    }
    /// Same as [`Self::search`] but also extracts per-citation titles when
    /// the Responses API surfaces them. Returns `(content, citations_with_titles)`
    /// where each citation is `(title, url)`. Empty `title` strings indicate
    /// the upstream didn't supply one for that URL.
    ///
    /// Used by the cursor-compat `WebSearch` adapter to render a
    /// `Links:\n1. [title](url)` list instead of the LLM synthesis text.
    pub async fn search_with_titles(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), xai_tool_runtime::ToolError> {
        match self.backend() {
            Backend::Retrieval => return self.retrieval_search(query, allowed_domains).await,
            Backend::RouterPlugin => {
                // Learned-good path. If the router stops grounding (plugin
                // disabled, model swapped), an un-annotated reply must not be
                // served as a search result — re-probe downward instead.
                if let Some(found) = self
                    .router_plugin_search(query, allowed_domains.clone())
                    .await?
                {
                    return Ok(found);
                }
                tracing::info!("router stopped returning citations; falling back to retrieval");
                self.remember_backend(Backend::Retrieval);
                return self.retrieval_search(query, allowed_domains).await;
            }
            _ => {}
        }
        match self
            .hosted_search_with_titles(query, allowed_domains.clone())
            .await
        {
            Ok(found) => {
                self.remember_backend(Backend::Responses);
                Ok(found)
            }
            Err(HostedSearchError::Unsupported(detail)) => {
                tracing::info!(
                    detail = %detail,
                    model = %self.model,
                    "endpoint does not serve hosted web search; trying the router web plugin",
                );
                // The endpoint answers chat but not the Responses API. If it is
                // an OpenAI-compatible router it may still search for us, which
                // beats retrieving ourselves — try that before falling back.
                if let Some(found) = self
                    .router_plugin_search(query, allowed_domains.clone())
                    .await?
                {
                    tracing::info!("router grounded the answer with citations; using that backend");
                    self.remember_backend(Backend::RouterPlugin);
                    return Ok(found);
                }
                self.remember_backend(Backend::Retrieval);
                self.retrieval_search(query, allowed_domains).await
            }
            Err(HostedSearchError::Failed(error)) => Err(error),
        }
    }

    /// The hosted path: one Responses API call with the server-side web search
    /// tool. Separated from [`Self::search_with_titles`] so an endpoint's
    /// "I don't do that" is distinguishable from a genuine failure.
    async fn hosted_search_with_titles(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), HostedSearchError> {
        let web_search = rs::WebSearchToolArgs::default()
            .filters(rs::WebSearchToolFilters { allowed_domains })
            .build()
            .map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Failed to build web search tool: {e}"),
                )
            })?;
        let request = rs::CreateResponseArgs::default()
            .model(self.model.clone())
            .input(query.to_string())
            .tools(vec![rs::Tool::WebSearch(web_search)])
            .store(false)
            .temperature(0.1)
            .top_p(0.95)
            .max_output_tokens(8192u32)
            .build()
            .map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Failed to build request: {e}"),
                )
            })?;
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));
        let sent_bearer = self.current_bearer().await;
        let mut req = self.http.post(&url).json(&request);
        if let Some(ref key) = sent_bearer {
            req = req.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = req.send().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("HTTP request failed: {e}"),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(sent_bearer.as_deref());
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(HostedSearchError::Failed(
                xai_tool_runtime::ToolError::unauthorized(format!(
                    "Responses API returned 401 Unauthorized: {body}"
                ))
                .with_details(serde_json::json!({ "tool_id" : "web_search", "status" : 401, })),
            ));
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            if Self::indicates_no_hosted_search(status, &body) {
                return Err(HostedSearchError::Unsupported(format!("{status}: {body}")));
            }
            return Err(HostedSearchError::Failed(
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Responses API returned {status}: {body}"),
                ),
            ));
        }
        let bytes = response.bytes().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to read response body: {e}"),
            )
        })?;
        let response_obj: rs::Response = serde_json::from_slice(&bytes).map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to parse response: {e}"),
            )
        })?;
        let content = response_obj
            .output_text()
            .unwrap_or_else(|| "No search results found.".to_string());
        let pairs = extract_citation_pairs(&response_obj);
        Ok((content, pairs))
    }
}
/// Pull `(content, citations)` out of a router chat-completion that carried
/// `url_citation` annotations.
///
/// Returns `None` when the reply has no annotations — meaning the router
/// ignored the plugin member and answered from the model alone. An ungrounded
/// answer must NOT be passed off as a web search result: that is the failure
/// this whole tool exists to prevent, and it is invisible unless checked here.
///
/// Pure so it is testable without a live router. Both the OpenAI-style
/// `{type, url_citation:{url,title}}` and a flattened `{url,title}` are
/// accepted; a router renaming a field degrades to `None`, never a panic.
fn parse_router_annotations(
    payload: &serde_json::Value,
) -> Option<(String, Vec<(String, String)>)> {
    let message = payload.pointer("/choices/0/message")?;
    let annotations = message.get("annotations")?.as_array()?;
    let mut citations: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for annotation in annotations {
        let cite = annotation.get("url_citation").unwrap_or(annotation);
        let Some(url) = cite.get("url").and_then(|v| v.as_str()) else {
            continue;
        };
        if !url.starts_with("http") || !seen.insert(url.to_string()) {
            continue;
        }
        let title = cite
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        citations.push((title, url.to_string()));
    }
    if citations.is_empty() {
        return None;
    }
    let content = message
        .get("content")
        .and_then(|v| v.as_str())
        .filter(|text| !text.trim().is_empty())?
        .to_string();
    Some((content, citations))
}

/// Why the hosted (Responses API) search path did not produce an answer.
///
/// The distinction is the whole point: `Unsupported` means this endpoint never
/// offered hosted search and the retrieval fallback should take over silently,
/// while `Failed` is a real error the user needs to see.
enum HostedSearchError {
    Unsupported(String),
    Failed(xai_tool_runtime::ToolError),
}

impl From<xai_tool_runtime::ToolError> for HostedSearchError {
    fn from(error: xai_tool_runtime::ToolError) -> Self {
        Self::Failed(error)
    }
}

/// Extract `(title, url)` pairs from the Responses API annotations.
///
/// `title` may be an empty string when upstream doesn't supply one. URLs
/// are deduplicated while preserving the first-seen order so the rendered
/// `Links:` list is stable and free of duplicates.
fn extract_citation_pairs(response: &rs::Response) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for output_item in &response.output {
        if let rs::OutputItem::Message(output_message) = output_item {
            for message_content in &output_message.content {
                if let rs::OutputMessageContent::OutputText(text_content) = message_content {
                    for annotation in &text_content.annotations {
                        if let rs::Annotation::UrlCitation(url_citation) = annotation
                            && let Ok(json) = serde_json::to_value(url_citation)
                        {
                            let url = json.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            if url.is_empty() {
                                continue;
                            }
                            let title = json
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            pairs.push((title, url.to_string()));
                        }
                    }
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    pairs.retain(|(_t, url)| seen.insert(url.clone()));
    pairs
}
#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    /// Helper to create a Response from JSON for testing.
    fn response_from_json(json: serde_json::Value) -> rs::Response {
        serde_json::from_value(json).expect("Failed to parse test Response JSON")
    }
    #[test]
    fn test_new_client_uses_configured_model() {
        let config = WebSearchConfig::Enabled {
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "custom-enterprise-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let client = WebSearchClient::new(&config, None).expect("client should build");
        assert_eq!(client.model, "custom-enterprise-model");
    }
    /// Counts attribution callback invocations for the test below.
    #[derive(Default, Debug)]
    struct CountingCallback {
        invocations: std::sync::Mutex<Vec<(ToolConsumer, Option<String>)>>,
    }
    impl crate::attribution::Auth401AttributionCallback for CountingCallback {
        fn record_401(&self, consumer: ToolConsumer, sent_bearer_prefix: Option<&str>) {
            self.invocations
                .lock()
                .unwrap()
                .push((consumer, sent_bearer_prefix.map(|s| s.to_string())));
        }
    }
    /// `record_401_attribution` invokes the wired callback with
    /// `ToolConsumer::WebSearch` and the truncated bearer prefix.
    /// The full bearer never crosses the trait boundary.
    #[test]
    fn record_401_attribution_passes_truncated_prefix_to_callback() {
        let cb = std::sync::Arc::new(CountingCallback::default());
        let cb_dyn: crate::attribution::SharedAttributionCallback = cb.clone();
        let config = WebSearchConfig::Enabled {
            api_key: "ignored".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let client = WebSearchClient::new(&config, None)
            .expect("client should build")
            .with_attribution_callback(Some(cb_dyn));
        client.record_401_attribution(Some("bearer-with-long-tail-aaaaaaaaaa"));
        let calls = cb.invocations.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, ToolConsumer::WebSearch);
        assert_eq!(calls[0].1.as_deref(), Some("bearer-with-"));
        assert_eq!(
            calls[0].1.as_deref().map(str::len),
            Some(crate::attribution::SENT_BEARER_PREFIX_LEN),
        );
    }
    /// `record_401_attribution` is a no-op when no callback is wired
    /// -- the BYOK / standalone case must not panic or allocate.
    #[test]
    fn record_401_attribution_is_noop_without_callback() {
        let config = WebSearchConfig::Enabled {
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let client = WebSearchClient::new(&config, None).expect("client should build");
        client.record_401_attribution(Some("any-bearer"));
        client.record_401_attribution(None);
    }
    #[test]
    fn router_annotations_become_content_and_citations() {
        let payload = serde_json::json!({
            "choices": [{"message": {
                "content": "Zig 0.16.0 is the latest release [1].",
                "annotations": [
                    {"type": "url_citation", "url_citation": {
                        "url": "https://ziglang.org/download/", "title": "Downloads"}},
                    // Duplicate URL: one citation, not two.
                    {"type": "url_citation", "url_citation": {
                        "url": "https://ziglang.org/download/", "title": "Downloads again"}},
                    // Flattened shape, and a non-http entry that is not a source.
                    {"url": "https://ziglang.org/news/", "title": "News"},
                    {"url": "not-a-url"},
                ],
            }}]
        });
        let (content, citations) = parse_router_annotations(&payload).expect("grounded reply");
        assert!(content.contains("0.16.0"));
        assert_eq!(
            citations,
            vec![
                (
                    "Downloads".to_string(),
                    "https://ziglang.org/download/".to_string()
                ),
                ("News".to_string(), "https://ziglang.org/news/".to_string()),
            ]
        );
    }

    #[test]
    fn an_ungrounded_router_reply_is_not_a_search_result() {
        // The failure this guards: a router that ignores the plugin answers 200
        // with a fluent, sourceless answer. Serving that as a web search is
        // exactly the silent wrongness the tool exists to prevent, so every
        // annotation-less shape must decline and let the caller fall back.
        for payload in [
            serde_json::json!({"choices": [{"message": {"content": "I think it is 0.16."}}]}),
            serde_json::json!({"choices": [{"message": {
                "content": "answer", "annotations": []}}]}),
            serde_json::json!({"choices": [{"message": {
                "content": "", "annotations": [
                    {"url_citation": {"url": "https://x.test"}}]}}]}),
            serde_json::json!({"choices": []}),
            serde_json::json!({"error": {"message": "nope"}}),
        ] {
            assert!(
                parse_router_annotations(&payload).is_none(),
                "must decline: {payload}"
            );
        }
    }

    #[test]
    fn citation_pairs_empty_response() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "output" : [], "model" : "test-model" }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert!(citations.is_empty());
    }
    #[test]
    fn citation_pairs_with_url_citations() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "model" : "test-model", "output" : [{ "type" :
            "message", "id" : "msg_1", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" :
            "Here is some info about Rust.", "annotations" : [{ "type" :
            "url_citation", "url" : "https://www.rust-lang.org/", "title" :
            "Rust Programming Language", "start_index" : 0, "end_index" : 10 }, {
            "type" : "url_citation", "url" : "https://docs.rs/", "title" : "Docs.rs",
            "start_index" : 11, "end_index" : 20 }] }] }] }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0], "https://www.rust-lang.org/");
        assert_eq!(citations[1], "https://docs.rs/");
    }
    #[test]
    fn citation_pairs_deduplicates() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "model" : "test-model", "output" : [{ "type" :
            "message", "id" : "msg_1", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" :
            "Info with duplicate citations.", "annotations" : [{ "type" :
            "url_citation", "url" : "https://example.com/page1", "title" : "Page 1",
            "start_index" : 0, "end_index" : 5 }, { "type" : "url_citation", "url" :
            "https://example.com/page2", "title" : "Page 2", "start_index" : 6,
            "end_index" : 10 }, { "type" : "url_citation", "url" :
            "https://example.com/page1", "title" : "Page 1 Again", "start_index" :
            11, "end_index" : 15 }] }] }] }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0], "https://example.com/page1");
        assert_eq!(citations[1], "https://example.com/page2");
    }
    #[test]
    fn citation_pairs_multiple_messages() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "model" : "test-model", "output" : [{ "type" :
            "message", "id" : "msg_1", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" : "First message",
            "annotations" : [{ "type" : "url_citation", "url" : "https://first.com/",
            "title" : "First", "start_index" : 0, "end_index" : 5 }] }] }, { "type" :
            "message", "id" : "msg_2", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" : "Second message",
            "annotations" : [{ "type" : "url_citation", "url" :
            "https://second.com/", "title" : "Second", "start_index" : 0, "end_index"
            : 6 }] }] }] }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0], "https://first.com/");
        assert_eq!(citations[1], "https://second.com/");
    }
    #[test]
    fn citation_pairs_ignores_non_url_annotations() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "model" : "test-model", "output" : [{ "type" :
            "message", "id" : "msg_1", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" : "Some text",
            "annotations" : [{ "type" : "url_citation", "url" : "https://valid.com/",
            "title" : "Valid", "start_index" : 0, "end_index" : 4 }] }] }] }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert_eq!(citations.len(), 1);
        assert_eq!(citations[0], "https://valid.com/");
    }
    /// A provider that always returns `None`, simulating an API-key user
    /// whose token has aged past the client-side TTL.
    struct NoneProvider;
    impl crate::types::ApiKeyProvider for NoneProvider {
        fn current_api_key(&self) -> Option<String> {
            None
        }
    }
    /// When the dynamic provider returns `None`, the static `api_key`
    /// from config must still be sent as the Authorization header.
    /// This is a regression scenario: API-key users
    /// past the 30-day client TTL saw 401 because no auth was sent.
    #[tokio::test]
    async fn static_api_key_is_fallback_when_provider_returns_none() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(header("Authorization", "Bearer static-key-from-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(
                { "id" : "resp_test", "object" : "response", "created_at" :
                1234567890, "status" : "completed", "model" : "test-model",
                "output" : [{ "type" : "message", "id" : "msg_1", "status" :
                "completed", "role" : "assistant", "content" : [{ "type" :
                "output_text", "text" : "search result", "annotations" : []
                }] }] }
            )))
            .mount(&server)
            .await;
        let config = WebSearchConfig::Enabled {
            api_key: "static-key-from-config".to_string(),
            base_url: server.uri(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(NoneProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("test query", None)
            .await
            .expect("search must succeed with static key fallback");
        assert_eq!(content, "search result");
    }
    /// When the provider returns a fresh key, it overrides the static one.
    #[tokio::test]
    async fn provider_key_overrides_static_key() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        struct FreshProvider;
        impl crate::types::ApiKeyProvider for FreshProvider {
            fn current_api_key(&self) -> Option<String> {
                Some("fresh-key-from-provider".to_string())
            }
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(header("Authorization", "Bearer fresh-key-from-provider"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(
                { "id" : "resp_test", "object" : "response", "created_at" :
                1234567890, "status" : "completed", "model" : "test-model",
                "output" : [{ "type" : "message", "id" : "msg_1", "status" :
                "completed", "role" : "assistant", "content" : [{ "type" :
                "output_text", "text" : "fresh result", "annotations" : [] }]
                }] }
            )))
            .mount(&server)
            .await;
        let config = WebSearchConfig::Enabled {
            api_key: "stale-static-key".to_string(),
            base_url: server.uri(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(FreshProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("test query", None)
            .await
            .expect("search must succeed with provider key");
        assert_eq!(content, "fresh result");
    }
    #[test]
    fn citation_pairs_no_annotations() {
        let response = response_from_json(serde_json::json!(
            { "id" : "resp_test", "object" : "response", "created_at" : 1234567890,
            "status" : "completed", "model" : "test-model", "output" : [{ "type" :
            "message", "id" : "msg_1", "status" : "completed", "role" : "assistant",
            "content" : [{ "type" : "output_text", "text" :
            "Plain text with no annotations", "annotations" : [] }] }] }
        ));
        let citations: Vec<String> = extract_citation_pairs(&response)
            .into_iter()
            .map(|(_, url)| url)
            .collect();
        assert!(citations.is_empty());
    }
}
