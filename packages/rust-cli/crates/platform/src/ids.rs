//! Identifiers that carry identity, minted from the cryptographic random source (the platform crate is the one entry for
//! such randomness, `clippy.toml`). Node mints the same ids with `crypto.randomUUID()`.

/// A random v4 uuid in its canonical 8-4-4-4-12 lower-case hex form, from the system's CSPRNG (ring's `SystemRandom`).
///
/// If the system source fails, this panics rather than returning a predictable id: a run id or a launch input id that
/// an attacker could guess is a security fault, not a value to fall back from.
pub fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    system_random(&mut bytes);
    uuid_from_bytes(bytes)
}

#[expect(
    clippy::disallowed_methods,
    clippy::expect_used,
    reason = "platform is the entry for cryptographic randomness (§4): run and launch ids must not be guessable, so a failed source panics rather than falling back"
)]
fn system_random(bytes: &mut [u8]) {
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(bytes)
        .expect("the system's cryptographic random source is available");
}

/// Fork (W9a, 9.53): a random v7 uuid (RFC 9562: a 48-bit millisecond timestamp, then random bits), the form Node's
/// `uuidv7()` mints for a hub launch's input id. The random part comes from the same CSPRNG as `uuid_v4`.
pub fn uuid_v7(unix_millis: u64) -> String {
    // The field holds 48 bits; a value outside it is a unit mistake (seconds, micro- or nanoseconds), caught in debug builds.
    debug_assert!(
        unix_millis < 1 << 48,
        "a v7 uuid takes unix milliseconds, which fit in 48 bits"
    );
    let mut bytes = [0u8; 16];
    system_random(&mut bytes);
    let millis = unix_millis.to_be_bytes();
    bytes[..6].copy_from_slice(&millis[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    canonical_text(bytes)
}

/// The v4 layout of 16 random bytes: version nibble 4, RFC 4122 variant bits, then the canonical text form.
fn uuid_from_bytes(mut bytes: [u8; 16]) -> String {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    canonical_text(bytes)
}

/// The canonical 8-4-4-4-12 lower-case hex text of 16 bytes (shared by the v4 and v7 layouts).
fn canonical_text(bytes: [u8; 16]) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_layout_is_a_v4_uuid_in_canonical_text() {
        let id = uuid_from_bytes([0xff; 16]);
        assert_eq!(id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
        let zero = uuid_from_bytes([0; 16]);
        assert_eq!(zero, "00000000-0000-4000-8000-000000000000");
    }

    #[test]
    fn minted_ids_are_canonical_v4_and_differ() {
        let first = uuid_v4();
        let second = uuid_v4();
        assert_ne!(first, second, "two draws from the CSPRNG differ");
        for id in [&first, &second] {
            assert_eq!(id.len(), 36, "{id}");
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(
                parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
                [8, 4, 4, 4, 12]
            );
            assert!(
                id.chars()
                    .all(|c| c == '-' || (c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
            );
            assert_eq!(&parts[2][0..1], "4", "version nibble: {id}");
            assert!(
                matches!(&parts[3][0..1], "8" | "9" | "a" | "b"),
                "variant: {id}"
            );
        }
    }
}

#[cfg(test)]
mod v7_tests {
    use super::uuid_v7;

    #[test]
    fn a_v7_uuid_carries_the_millisecond_clock_then_random_bits() {
        let id = uuid_v7(0x0123_4567_89ab);
        assert_eq!(&id[..8], "01234567");
        assert_eq!(&id[9..13], "89ab");
        assert_eq!(id.as_bytes()[14], b'7', "the version nibble is 7: {id}");
        assert!(
            matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'),
            "{id}"
        );
        assert_eq!(id.len(), 36);
        assert_ne!(uuid_v7(1), uuid_v7(1), "the random part differs per call");
    }
}
