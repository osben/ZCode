//! PKCE S256 (RFC 7636). The verifier is base64url of random bytes supplied by the runtime (entropy
//! is an entry-crate category), and the challenge is base64url of its SHA-256.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// A verifier from 32 random bytes is 43 characters, the RFC 7636 minimum.
pub fn verifier_from_bytes(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(verifier))` without padding.
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
