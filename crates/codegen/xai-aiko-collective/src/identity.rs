//! Publisher identity backed by the native OS credential store. Contract
//! defines the signing bytes; private seed material never crosses its ABI.

use crate::{CollectiveContract, CollectiveError};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};

const SERVICE: &str = "dev.aiko.collective";
const ACCOUNT: &str = "publisher-ed25519-v1";

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("native credential store failed: {0}")]
    Credential(String),
    #[error("stored collective identity is malformed")]
    MalformedSecret,
    #[error("collective candidate publisher does not match the local identity")]
    PublisherMismatch,
    #[error("Contract signing policy failed: {0}")]
    Contract(#[from] CollectiveError),
}

pub trait IdentitySecretStore {
    fn get(&self) -> Result<Option<String>, IdentityError>;
    fn set(&self, secret: &str) -> Result<(), IdentityError>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeIdentitySecretStore;

impl NativeIdentitySecretStore {
    fn entry() -> Result<keyring::Entry, IdentityError> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|error| IdentityError::Credential(error.to_string()))
    }
}

impl IdentitySecretStore for NativeIdentitySecretStore {
    fn get(&self) -> Result<Option<String>, IdentityError> {
        match Self::entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(IdentityError::Credential(error.to_string())),
        }
    }

    fn set(&self, secret: &str) -> Result<(), IdentityError> {
        Self::entry()?
            .set_password(secret)
            .map_err(|error| IdentityError::Credential(error.to_string()))
    }
}

pub struct PublisherIdentity {
    key: Ed25519KeyPair,
    publisher_key_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignedCollectiveObject {
    pub object_id: String,
    pub unsigned: serde_json::Value,
    pub signature_hex: String,
    pub publisher_key_hex: String,
    pub envelope: serde_json::Value,
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_32(value: &str) -> Result<[u8; 32], IdentityError> {
    if value.len() != 64 {
        return Err(IdentityError::MalformedSecret);
    }
    let mut bytes = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            _ => None,
        };
        bytes[index] = (nibble(pair[0]).ok_or(IdentityError::MalformedSecret)? << 4)
            | nibble(pair[1]).ok_or(IdentityError::MalformedSecret)?;
    }
    Ok(bytes)
}

impl PublisherIdentity {
    pub fn load_or_create(store: &impl IdentitySecretStore) -> Result<Self, IdentityError> {
        let mut seed = match store.get()? {
            Some(secret) => decode_32(&secret)?,
            None => {
                use ring::rand::SecureRandom;
                let mut seed = [0_u8; 32];
                ring::rand::SystemRandom::new()
                    .fill(&mut seed)
                    .map_err(|_| IdentityError::MalformedSecret)?;
                store.set(&encode_hex(&seed))?;
                seed
            }
        };
        let key = Ed25519KeyPair::from_seed_unchecked(&seed)
            .map_err(|_| IdentityError::MalformedSecret)?;
        seed.fill(0);
        let publisher_key_hex = encode_hex(key.public_key().as_ref());
        Ok(Self {
            key,
            publisher_key_hex,
        })
    }

    pub fn publisher(&self) -> String {
        format!("ed25519:{}", self.publisher_key_hex)
    }

    pub fn sign(
        &self,
        contract: &CollectiveContract,
        candidate: &[u8],
    ) -> Result<SignedCollectiveObject, IdentityError> {
        let canonical = contract.canonicalize(candidate)?;
        let publisher = self.publisher();
        if canonical.canonical["publisher"].as_str() != Some(publisher.as_str()) {
            return Err(IdentityError::PublisherMismatch);
        }
        let payload = contract.signing_payload(candidate)?;
        let payload = decode_32(
            payload["payload_hex"]
                .as_str()
                .ok_or(IdentityError::MalformedSecret)?,
        )?;
        let signature_hex = encode_hex(self.key.sign(&payload).as_ref());
        let object_id = canonical.object_id;
        let unsigned = canonical.canonical;
        let envelope = serde_json::json!({
            "protocol": "aiko-collective/1",
            "object_id": object_id.clone(),
            "unsigned": unsigned.clone(),
            "signature": format!("ed25519:{signature_hex}")
        });
        Ok(SignedCollectiveObject {
            object_id,
            unsigned,
            signature_hex,
            publisher_key_hex: self.publisher_key_hex.clone(),
            envelope,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);

    impl IdentitySecretStore for MemoryStore {
        fn get(&self) -> Result<Option<String>, IdentityError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn set(&self, secret: &str) -> Result<(), IdentityError> {
            *self.0.lock().unwrap() = Some(secret.to_owned());
            Ok(())
        }
    }

    #[test]
    fn publisher_identity_is_stable_without_exposing_secret() {
        let store = MemoryStore::default();
        let first = PublisherIdentity::load_or_create(&store).unwrap();
        let second = PublisherIdentity::load_or_create(&store).unwrap();
        assert_eq!(first.publisher(), second.publisher());
        assert_eq!(first.publisher().len(), 72);
    }
}
