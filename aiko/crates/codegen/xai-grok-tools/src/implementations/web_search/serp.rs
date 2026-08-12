//! A search backend for endpoints that cannot serve the Responses API.
//!
//! The `web_search` tool was written against one assumption: the configured
//! model endpoint hosts a server-side `web_search` tool over the Responses API.
//! When that assumption does not hold, the tool has no fallback and every call
//! fails — an endpoint may answer chat completions perfectly while rejecting
//! `/responses` outright, or accept `/responses` but refuse hosted tools
//! ("Hosted tool 'web_search' isn't billable ... use function tools instead").
//! Either way there is nothing wrong with the user's credentials or query.
//!
//! This module supplies the missing half: fetch real results ourselves, then
//! let the ordinary chat-completions endpoint synthesize an answer over them.
//! The retrieval is deliberately keyless so the fallback works with no extra
//! configuration; set `[web_search] serp_url` to point it at a SERP API you
//! already pay for.

use serde::Deserialize;

/// One search hit, before synthesis.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SerpResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// How many hits to carry into synthesis. Enough for corroboration across
/// sources, small enough to stay well inside a single prompt.
const MAX_RESULTS: usize = 8;

/// Build the query string, folding `allowed_domains` into `site:` filters the
/// way the Responses API filter would have.
pub fn build_query(query: &str, allowed_domains: Option<&[String]>) -> String {
    let Some(domains) = allowed_domains.filter(|d| !d.is_empty()) else {
        return query.to_string();
    };
    let sites = domains
        .iter()
        .map(|domain| format!("site:{domain}"))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("{query} ({sites})")
}

/// An HTTP client for the search engine ONLY.
///
/// Deliberately built fresh rather than reusing the model client: that one
/// carries the gateway bearer as a default header, and reusing it here would
/// send the user's API credential to an unrelated third-party host on every
/// search. A search backend never needs our model credentials.
fn search_http_client() -> Result<reqwest::Client, xai_tool_runtime::ToolError> {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        )
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to build search HTTP client: {e}"),
            )
        })
}

/// Shape returned by a JSON SERP API (Serper/Brave/Tavily-style). Only the
/// fields we need; every provider spells them slightly differently, so each
/// alternative is accepted.
#[derive(Debug, Deserialize)]
struct JsonSerpEnvelope {
    #[serde(alias = "organic", alias = "web", alias = "items")]
    results: Option<Vec<JsonSerpHit>>,
}

#[derive(Debug, Deserialize)]
struct JsonSerpHit {
    #[serde(default)]
    title: String,
    #[serde(default, alias = "link")]
    url: String,
    #[serde(default, alias = "description", alias = "content")]
    snippet: String,
}

/// Retrieve results for `query`, in order of preference:
///
/// 1. a configured JSON SERP endpoint — explicit configuration always wins;
/// 2. the local `unbrowse` CLI, when it is installed — it carries its own
///    search credentials, so this is the only backend that works with no
///    configuration at all;
/// 3. the keyless HTML endpoint, which bot-challenges most non-residential
///    hosts and so cannot be relied on as the sole default.
///
/// Every step is skipped silently when unavailable; only exhausting all three
/// is an error, and it names the remedy.
pub async fn search(
    query: &str,
    serp_url: Option<&str>,
    serp_api_key: Option<&str>,
) -> Result<Vec<SerpResult>, xai_tool_runtime::ToolError> {
    let client = search_http_client()?;
    if let Some(url) = serp_url {
        return json_serp(&client, url, serp_api_key, query).await;
    }
    if let Some(binary) = unbrowse_binary() {
        match unbrowse_search(&binary, query).await {
            Ok(results) if !results.is_empty() => return Ok(results),
            Ok(_) => tracing::info!("unbrowse returned no candidates; trying the keyless engine"),
            Err(error) => {
                tracing::info!(%error, "unbrowse search unavailable; trying the keyless engine")
            }
        }
    }
    duckduckgo(&client, query).await
}

/// The `unbrowse` CLI to shell out to, or `None` when the backend is disabled
/// or not installed. `AIKO_WEB_SEARCH_UNBROWSE` takes a path, or `0`/`off` to
/// opt out (it spends the user's unbrowse credits, so it must be refusable).
fn unbrowse_binary() -> Option<String> {
    unbrowse_binary_from(std::env::var("AIKO_WEB_SEARCH_UNBROWSE").ok())
}

/// The setting-to-binary decision, taking the setting as an argument so it is
/// testable without mutating process environment out from under other tests.
fn unbrowse_binary_from(setting: Option<String>) -> Option<String> {
    match setting {
        Some(value)
            if matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "off" | "false"
            ) =>
        {
            None
        }
        Some(value) if value.contains(std::path::MAIN_SEPARATOR) => Some(value),
        _ => which_on_path("unbrowse"),
    }
}

fn which_on_path(binary: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.display().to_string())
}

/// Search via the local `unbrowse` CLI.
///
/// `unbrowse "<task>" --json` runs its full resolve-and-walk pipeline; the
/// ranked search candidates it consulted are in `result.exa_candidates`, and
/// they are present even when the page walk itself is inconclusive — which is
/// exactly the part a SERP backend needs.
async fn unbrowse_search(
    binary: &str,
    query: &str,
) -> Result<Vec<SerpResult>, xai_tool_runtime::ToolError> {
    let fail = |detail: String| {
        xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            detail,
        )
    };
    let mut command = tokio::process::Command::new(binary);
    command
        .arg(query)
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(UNBROWSE_TIMEOUT_SECS),
        command.output(),
    )
    .await
    .map_err(|_| {
        fail(format!(
            "unbrowse did not answer within {UNBROWSE_TIMEOUT_SECS}s"
        ))
    })?
    .map_err(|e| fail(format!("could not run unbrowse: {e}")))?;
    if !output.status.success() {
        return Err(fail(format!("unbrowse exited with {}", output.status)));
    }
    let payload: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| fail(format!("unbrowse emitted unparseable JSON: {e}")))?;
    Ok(parse_unbrowse_payload(&payload))
}

/// Wall clock for one `unbrowse` search. Its pipeline can legitimately take
/// half a minute; past that a search is no longer useful to a waiting turn.
const UNBROWSE_TIMEOUT_SECS: u64 = 90;

/// Pull ranked candidates out of an `unbrowse --json` payload.
///
/// Split from the process call so the shape is testable without the CLI. Both
/// the nested and top-level spellings are accepted: this is another program's
/// output, and a rename there should degrade to "no results", never a panic.
pub fn parse_unbrowse_payload(payload: &serde_json::Value) -> Vec<SerpResult> {
    [
        "/result/exa_candidates",
        "/exa_candidates",
        "/result/candidates",
    ]
    .iter()
    .find_map(|pointer| payload.pointer(pointer).and_then(|v| v.as_array()))
    .map(|candidates| {
        candidates
            .iter()
            .filter_map(|candidate| {
                let url = candidate.get("url")?.as_str()?.to_string();
                if !url.starts_with("http") {
                    return None;
                }
                Some(SerpResult {
                    title: candidate
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    url,
                    snippet: candidate
                        .get("highlights_excerpt")
                        .or_else(|| candidate.get("snippet"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .take(MAX_RESULTS)
            .collect()
    })
    .unwrap_or_default()
}

async fn json_serp(
    client: &reqwest::Client,
    url: &str,
    api_key: Option<&str>,
    query: &str,
) -> Result<Vec<SerpResult>, xai_tool_runtime::ToolError> {
    let mut request = client.post(url).json(&serde_json::json!({ "q": query }));
    if let Some(key) = api_key {
        // Both header spellings in common use; sending both is harmless and
        // saves a per-provider config knob.
        request = request
            .header("X-API-KEY", key)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let response = request.send().await.map_err(|e| {
        xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            format!("Search backend request failed: {e}"),
        )
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            format!("Search backend returned {status}: {}", truncate(&body, 400)),
        ));
    }
    let envelope: JsonSerpEnvelope = response.json().await.map_err(|e| {
        xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            format!("Search backend returned an unrecognized payload: {e}"),
        )
    })?;
    Ok(envelope
        .results
        .unwrap_or_default()
        .into_iter()
        .filter(|hit| !hit.url.is_empty())
        .map(|hit| SerpResult {
            title: hit.title,
            url: hit.url,
            snippet: hit.snippet,
        })
        .take(MAX_RESULTS)
        .collect())
}

async fn duckduckgo(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<SerpResult>, xai_tool_runtime::ToolError> {
    let response = client
        .post("https://html.duckduckgo.com/html/")
        .form(&[("q", query)])
        .send()
        .await
        .map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Search request failed: {e}"),
            )
        })?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            format!("Search endpoint returned {status}"),
        ));
    }
    let html = response.text().await.map_err(|e| {
        xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            format!("Failed to read search results: {e}"),
        )
    })?;
    // A bot challenge is served as a 200/202 page with no results in it. Parsing
    // it yields an empty list, which is indistinguishable from "the web has
    // nothing on this" — the difference between "your query found nothing" and
    // "we were never allowed to ask" matters far too much to collapse.
    if is_bot_challenge(&html) {
        return Err(xai_tool_runtime::ToolError::execution(
            xai_tool_protocol::ToolId::new("web_search").expect("valid"),
            NO_BACKEND_MESSAGE.to_string(),
        ));
    }
    Ok(parse_duckduckgo_html(&html))
}

/// What to tell the user when there is no usable way to search.
///
/// This tool cannot invent a search engine: it needs either a model endpoint
/// that hosts web search, or a SERP provider of our own. Naming both remedies
/// beats an opaque upstream error that looks like a bug in the query.
pub const NO_BACKEND_MESSAGE: &str = "\
Web search has no available backend. The configured model endpoint does not \
host web search, `unbrowse` is not installed (or returned nothing), and the \
keyless fallback engine refused the request (bot challenge). Any one of these \
fixes it: install the `unbrowse` CLI; set AIKO_WEB_SEARCH_SERP_URL (plus \
AIKO_WEB_SEARCH_SERP_API_KEY if the provider needs one) to a JSON search API — \
Serper, Brave, Tavily and SearXNG all work; or point [models] web_search at an \
endpoint that serves the Responses API with a hosted web_search tool.";

/// Recognise an interstitial challenge rather than a result page.
fn is_bot_challenge(html: &str) -> bool {
    let html = html.to_ascii_lowercase();
    [
        "anomaly-modal",
        "unfortunately, bots use duckduckgo too",
        "captcha",
    ]
    .iter()
    .any(|marker| html.contains(marker))
}

/// Parse the keyless HTML SERP into results.
///
/// Split out from the request so the parser is testable without a network:
/// this is scraped markup, so it is the part most likely to rot.
pub fn parse_duckduckgo_html(html: &str) -> Vec<SerpResult> {
    let document = scraper::Html::parse_document(html);
    let Ok(row) = scraper::Selector::parse("div.result, div.web-result") else {
        return Vec::new();
    };
    let Ok(anchor) = scraper::Selector::parse("a.result__a") else {
        return Vec::new();
    };
    let Ok(snippet) = scraper::Selector::parse("a.result__snippet, div.result__snippet") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for element in document.select(&row) {
        let Some(link) = element.select(&anchor).next() else {
            continue;
        };
        let Some(href) = link.value().attr("href") else {
            continue;
        };
        let Some(url) = resolve_result_url(href) else {
            continue;
        };
        let title = collapse_whitespace(&link.text().collect::<String>());
        let snippet = element
            .select(&snippet)
            .next()
            .map(|node| collapse_whitespace(&node.text().collect::<String>()))
            .unwrap_or_default();
        out.push(SerpResult {
            title,
            url,
            snippet,
        });
        if out.len() == MAX_RESULTS {
            break;
        }
    }
    out
}

/// Unwrap the engine's redirect wrapper (`/l/?uddg=<percent-encoded target>`)
/// to the destination URL. A citation must point at the source, not at a
/// tracker that happens to forward there.
fn resolve_result_url(href: &str) -> Option<String> {
    let absolute = if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    };
    let parsed = url::Url::parse(&absolute).ok()?;
    if let Some((_, target)) = parsed.query_pairs().find(|(key, _)| key == "uddg") {
        return Some(target.into_owned());
    }
    (parsed.scheme() == "http" || parsed.scheme() == "https").then_some(absolute)
}

fn collapse_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(raw: &str, limit: usize) -> String {
    if raw.len() <= limit {
        return raw.to_string();
    }
    raw.chars().take(limit).collect()
}

/// Render results as the grounding block for synthesis. Numbered so the model
/// can cite `[n]` and the caller can map citations back to URLs.
pub fn render_for_synthesis(results: &[SerpResult]) -> String {
    let mut out = String::new();
    for (index, result) in results.iter().enumerate() {
        out.push_str(&format!(
            "[{}] {}\nURL: {}\n{}\n\n",
            index + 1,
            result.title,
            result.url,
            result.snippet
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_domains_become_site_filters() {
        assert_eq!(build_query("zig release", None), "zig release");
        assert_eq!(
            build_query("zig release", Some(&["ziglang.org".to_string()])),
            "zig release (site:ziglang.org)"
        );
        assert_eq!(
            build_query(
                "zig release",
                Some(&["ziglang.org".to_string(), "github.com".to_string()])
            ),
            "zig release (site:ziglang.org OR site:github.com)"
        );
        // An empty list is not a filter — it must not produce `()`.
        assert_eq!(build_query("zig release", Some(&[])), "zig release");
    }

    #[test]
    fn redirect_wrapper_resolves_to_the_source_url() {
        assert_eq!(
            resolve_result_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2Fdownload%2F"),
            Some("https://ziglang.org/download/".to_string())
        );
        assert_eq!(
            resolve_result_url("https://ziglang.org/download/"),
            Some("https://ziglang.org/download/".to_string())
        );
        // Non-http schemes are not citable sources.
        assert_eq!(resolve_result_url("javascript:void(0)"), None);
    }

    #[test]
    fn html_results_parse_to_title_url_and_snippet() {
        let html = r#"
            <div class="result">
              <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2F">Zig
              Programming   Language</a>
              <a class="result__snippet">Zig is a general-purpose  programming language.</a>
            </div>
            <div class="result">
              <a class="result__a" href="https://example.test/a">Example</a>
            </div>
        "#;
        let results = parse_duckduckgo_html(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Zig Programming Language");
        assert_eq!(results[0].url, "https://ziglang.org/");
        assert_eq!(
            results[0].snippet,
            "Zig is a general-purpose programming language."
        );
        // A result without a snippet is still a usable citation.
        assert_eq!(results[1].url, "https://example.test/a");
        assert!(results[1].snippet.is_empty());
    }

    #[test]
    fn synthesis_block_numbers_every_source() {
        let rendered = render_for_synthesis(&[
            SerpResult {
                title: "One".into(),
                url: "https://one.test".into(),
                snippet: "first".into(),
            },
            SerpResult {
                title: "Two".into(),
                url: "https://two.test".into(),
                snippet: "second".into(),
            },
        ]);
        assert!(rendered.contains("[1] One"));
        assert!(rendered.contains("URL: https://one.test"));
        assert!(rendered.contains("[2] Two"));
    }

    /// End-to-end proof of the retrieval backend with a provider configured:
    /// retrieve from a JSON SERP, synthesize over the ordinary
    /// chat-completions endpoint, return content plus citations. This is the
    /// path that replaces hosted web search on an endpoint that has none.
    ///
    /// Needs a live model endpoint, so it is `--ignored` and self-skips unless
    /// `AIKO_WEB_SEARCH_TEST_BASE_URL` / `_KEY` / `_MODEL` are set. Point
    /// `AIKO_WEB_SEARCH_SERP_URL` at any JSON SERP (a local stub is enough).
    #[tokio::test]
    #[ignore = "network"]
    async fn configured_serp_plus_chat_synthesis_answers_with_citations() {
        let (Ok(base_url), Ok(api_key)) = (
            std::env::var("AIKO_WEB_SEARCH_TEST_BASE_URL"),
            std::env::var("AIKO_WEB_SEARCH_TEST_KEY"),
        ) else {
            eprintln!("skipped: set AIKO_WEB_SEARCH_TEST_BASE_URL and _KEY to run");
            return;
        };
        let model = std::env::var("AIKO_WEB_SEARCH_TEST_MODEL")
            .expect("set AIKO_WEB_SEARCH_TEST_MODEL to a chat-completions model");
        let config = crate::implementations::web_search::WebSearchConfig::Enabled {
            api_key,
            base_url,
            model,
            extra_headers: Default::default(),
            alpha_test_key: None,
        };
        let client =
            crate::implementations::web_search::client::WebSearchClient::new(&config, None)
                .expect("client builds from enabled config");
        let (content, citations) = client
            .search("what is the zig programming language", None)
            .await
            .expect("retrieval + synthesis should answer");
        assert!(!content.trim().is_empty(), "synthesis produced no text");
        assert!(
            !citations.is_empty(),
            "an answer built from sources must carry its sources",
        );
        assert!(
            citations.iter().all(|url| url.starts_with("http")),
            "citations must be URLs: {citations:?}",
        );
    }

    #[test]
    fn unbrowse_candidates_become_search_results() {
        let payload = serde_json::json!({
            "result": {
                "walked_from": "exa-web-search",
                "exa_candidates": [
                    {
                        "url": "https://ziglang.org/",
                        "title": "Home Zig Programming Language",
                        "score": 1,
                        "highlights_excerpt": "Latest Release: 0.16.0",
                    },
                    // No title and a relative URL: a citation must be a real
                    // link, so this one is dropped rather than half-rendered.
                    {"url": "/relative/path", "title": "Nope"},
                ],
            }
        });
        let results = parse_unbrowse_payload(&payload);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://ziglang.org/");
        assert_eq!(results[0].title, "Home Zig Programming Language");
        assert_eq!(results[0].snippet, "Latest Release: 0.16.0");
    }

    #[test]
    fn an_unrecognized_unbrowse_payload_yields_no_results_not_a_panic() {
        assert!(parse_unbrowse_payload(&serde_json::json!({"result": {}})).is_empty());
        assert!(parse_unbrowse_payload(&serde_json::json!({"error": "nope"})).is_empty());
        assert!(parse_unbrowse_payload(&serde_json::Value::Null).is_empty());
    }

    #[test]
    fn unbrowse_backend_is_refusable_and_overridable() {
        // The CLI spends the user's credits, so an explicit opt-out must win
        // over a binary sitting on PATH.
        for off in ["0", "off", "false", "OFF"] {
            assert!(
                unbrowse_binary_from(Some(off.to_string())).is_none(),
                "{off} should disable the unbrowse backend",
            );
        }
        // An explicit path is used as given, without a PATH lookup.
        let explicit = format!(
            "{}opt{}unbrowse",
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert_eq!(unbrowse_binary_from(Some(explicit.clone())), Some(explicit));
    }

    #[test]
    fn a_bot_challenge_is_not_an_empty_result_set() {
        assert!(is_bot_challenge(
            r#"<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too</div>"#
        ));
        assert!(!is_bot_challenge(
            r#"<div class="result"><a class="result__a" href="https://x.test">X</a></div>"#
        ));
    }

    /// The scraped-HTML parser is the piece most likely to rot silently: the
    /// engine changes a class name, every search quietly returns zero results,
    /// and the unit tests above keep passing against frozen markup.
    ///
    /// The contract asserted here is "never silently empty": either real,
    /// resolved results, or an explicit refusal. A datacenter IP gets served a
    /// bot challenge, so demanding results outright would fail for an
    /// environmental reason while the code is correct. `--ignored`: network.
    #[tokio::test]
    #[ignore = "network"]
    async fn live_retrieval_returns_results_or_says_why_not() {
        match search("zig programming language releases", None, None).await {
            Ok(results) => {
                assert!(
                    !results.is_empty(),
                    "engine answered but nothing parsed — the HTML selectors have drifted",
                );
                assert!(
                    results
                        .iter()
                        .all(|hit| hit.url.starts_with("http") && !hit.url.contains("uddg=")),
                    "results must be resolved source URLs, not redirect wrappers: {results:?}",
                );
            }
            Err(error) => {
                let message = error.to_string();
                assert!(
                    message.contains("no available backend"),
                    "a refusal must name the remedy, got: {message}",
                );
            }
        }
    }
}
