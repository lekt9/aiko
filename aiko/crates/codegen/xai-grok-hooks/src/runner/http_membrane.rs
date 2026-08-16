use crate::data_membrane::HookDataPolicy;
use std::net::IpAddr;
use url::Url;

/// Constrain egress to an explicitly declared HTTPS host. Credentials in URL
/// authority and query strings are separate capabilities.
pub fn constrained_url(raw: &str, policy: &HookDataPolicy) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "invalid hook URL".to_string())?;
    if url.scheme() != "https" {
        return Err("HTTP hook egress requires https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "HTTP hook URL has no host".to_string())?;
    if !policy.allows_http_host(host) {
        return Err("HTTP hook destination lacks explicit host capability".into());
    }
    if (!url.username().is_empty() || url.password().is_some())
        && !policy.allows("http:credentials")
    {
        return Err("credentials in HTTP hook URL are denied".into());
    }
    if url.query().is_some() && !policy.allows("http:query") {
        return Err("HTTP hook query is denied".into());
    }
    if host.parse::<IpAddr>().is_ok() && !policy.allows("http:literal_ip") {
        return Err("literal-IP HTTP hook destination is denied".into());
    }
    Ok(url)
}
