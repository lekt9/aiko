//! Host projection of Contract's authoritative execution token.
//! The host transports this value verbatim; it never decides whether it is current.
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub(crate) fn owner_incarnation(owner: &str) -> String {
    static BOOT_NONCE: OnceLock<String> = OnceLock::new();
    let nonce = BOOT_NONCE.get_or_init(|| uuid::Uuid::new_v4().to_string());
    let mut hash = Sha256::new();
    for field in [
        b"contract.execution.incarnation/v1".as_slice(),
        owner.as_bytes(),
        nonce.as_bytes(),
    ] {
        hash.update(field.len().to_le_bytes());
        hash.update(field);
    }
    format!("{:x}", hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incarnation_is_stable_for_this_boot_and_not_an_owner_label() {
        let first = owner_incarnation("reused-label");
        assert_eq!(first, owner_incarnation("reused-label"));
        assert_eq!(first.len(), 64);
        assert_ne!(first, "reused-label");
    }
}
