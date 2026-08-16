//! MCP-side adapter into the host's mandatory Contract ingress.
//!
//! The MCP crate cannot depend on the shell composition root (the shell already
//! depends on MCP), so this type carries authenticated transport facts and raw
//! JSON-RPC bytes across that boundary.  It never consumes authority claims
//! from JSON-RPC params.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedMcpIngress {
    subject: String,
    tenant: String,
    audience: String,
    scopes: Vec<String>,
    verification_evidence: String,
    credential_generation: String,
    server_namespace: String,
    request_id: String,
    raw_json_rpc: Vec<u8>,
}

impl AuthenticatedMcpIngress {
    pub fn from_authenticated_session(
        subject: impl Into<String>,
        tenant: impl Into<String>,
        audience: impl Into<String>,
        scopes: Vec<String>,
        verification_evidence: impl Into<String>,
        credential_generation: impl Into<String>,
        server_namespace: impl Into<String>,
        request_id: impl Into<String>,
        raw_json_rpc: Vec<u8>,
    ) -> Result<Self, &'static str> {
        let mut value = Self {
            subject: subject.into(),
            tenant: tenant.into(),
            audience: audience.into(),
            scopes,
            verification_evidence: verification_evidence.into(),
            credential_generation: credential_generation.into(),
            server_namespace: server_namespace.into(),
            request_id: request_id.into(),
            raw_json_rpc,
        };
        value.scopes.sort();
        value.scopes.dedup();
        if value.subject.is_empty()
            || value.tenant.is_empty()
            || value.audience.is_empty()
            || value.scopes.is_empty()
            || value.verification_evidence.is_empty()
            || value.credential_generation.is_empty()
            || value.server_namespace.is_empty()
            || value.request_id.is_empty()
            || value.raw_json_rpc.is_empty()
        {
            return Err("mcp transport was not authenticated");
        }
        Ok(value)
    }
    pub fn subject(&self) -> &str {
        &self.subject
    }
    pub fn tenant(&self) -> &str {
        &self.tenant
    }
    pub fn audience(&self) -> &str {
        &self.audience
    }
    pub fn scopes(&self) -> &[String] {
        &self.scopes
    }
    pub fn verification_evidence(&self) -> &str {
        &self.verification_evidence
    }
    pub fn credential_generation(&self) -> &str {
        &self.credential_generation
    }
    pub fn nonce_namespace(&self) -> String {
        format!("mcp:{}", self.server_namespace)
    }
    pub fn idempotency_key(&self) -> &str {
        &self.request_id
    }
    pub fn raw_request(&self) -> &[u8] {
        &self.raw_json_rpc
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_authority_remains_untrusted_raw_stimulus() {
        let raw =
            br#"{"jsonrpc":"2.0","id":7,"params":{"tenant":"forged","role":"admin"}}"#.to_vec();
        let v = AuthenticatedMcpIngress::from_authenticated_session(
            "oauth:alice",
            "real-tenant",
            "mcp-server",
            vec!["tools.call".into()],
            "oauth-token-binding",
            "gen-2",
            "server-a",
            "7",
            raw.clone(),
        )
        .unwrap();
        assert_eq!(v.tenant(), "real-tenant");
        assert_eq!(v.raw_request(), raw);
        assert_eq!(v.nonce_namespace(), "mcp:server-a");
    }
}
