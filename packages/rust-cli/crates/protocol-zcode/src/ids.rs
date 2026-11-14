//! Random ids for wire messages that zod validates with `.uuid()`.

/// A random v4 uuid built from the crate's random source, because clippy forbids `uuid::Uuid::new_v4`.
/// The version and variant bits follow RFC 4122. The ids only correlate messages (a cipher reply, a hook review
/// flow or interaction); they are not secrets.
pub(crate) fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    bytes[8..].copy_from_slice(&rust_cli_base::random::u64().to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
