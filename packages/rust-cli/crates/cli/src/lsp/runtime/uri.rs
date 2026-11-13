//! Fork: `file:` URIs for language servers (specs/fork-rust-lsp.md "Pool", URIs). Root and workspace folders follow
//! Node adapters `lsp/paths.ts` `filePathToFileUri`; documents follow core `lsp/uri.ts` (`pathToFileURL`, then a
//! lowercase drive letter). A URI a server sends is matched after decoding it to a path and encoding it again.

/// The bytes Node's `pathToFileURL` percent-encodes in a path (checked against Node 26): tab, LF, CR, space and
/// `"#%<>?[\]^`{|}~`, DEL, and every non-ASCII byte. Other C0 controls stay raw, as in Node.
fn document_byte_encoded(byte: u8, windows: bool) -> bool {
    match byte {
        b'\t' | b'\n' | b'\r' | b' ' | b'"' | b'#' | b'%' | b'<' | b'>' | b'?' | b'[' | b']'
        | b'^' | b'`' | b'{' | b'|' | b'}' | b'~' | 0x7f => true,
        // A Windows backslash is a separator (turned into `/` first); a POSIX one is a file name character.
        b'\\' => !windows,
        _ => !byte.is_ascii(),
    }
}

/// `encodeURIComponent`: everything except `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
fn component_byte_encoded(byte: u8) -> bool {
    !(byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        ))
}

fn encode(text: &str, encoded: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for &byte in text.as_bytes() {
        if encoded(byte) {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

fn encode_segments(path: &str, encoded: impl Fn(u8) -> bool + Copy) -> String {
    path.split('/')
        .map(|segment| encode(segment, encoded))
        .collect::<Vec<_>>()
        .join("/")
}

/// `X:` or `X:/...` with an ASCII drive letter: `(letter, rest)`.
fn drive(path: &str) -> Option<(char, &str)> {
    let mut chars = path.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    let rest = path.get(1..)?.strip_prefix(':')?;
    (rest.is_empty() || rest.starts_with('/')).then_some((letter, rest))
}

/// Node `filePathToFileUri`: the root and workspace folders, each segment encoded like `encodeURIComponent`; a
/// Windows drive letter is lowercased and its colon kept.
pub(crate) fn folder_uri(path: &str, windows: bool) -> String {
    if !windows {
        return format!("file://{}", encode_segments(path, component_byte_encoded));
    }
    let slashed = path.replace('\\', "/");
    if let Some((letter, rest)) = drive(&slashed) {
        return format!(
            "file:///{}:{}",
            letter.to_ascii_lowercase(),
            encode_segments(rest, component_byte_encoded)
        );
    }
    format!("file:{}", encode_segments(&slashed, component_byte_encoded))
}

/// Node core `toFileUri`: `pathToFileURL(path)` with a lowercase drive letter.
pub(crate) fn document_uri(path: &str, windows: bool) -> String {
    if !windows {
        return format!(
            "file://{}",
            encode(path, |byte| document_byte_encoded(byte, false))
        );
    }
    let slashed = path.replace('\\', "/");
    let encoded = |byte| document_byte_encoded(byte, true);
    if let Some((letter, rest)) = drive(&slashed) {
        return format!(
            "file:///{}:{}",
            letter.to_ascii_lowercase(),
            encode(rest, encoded)
        );
    }
    // UNC: `//server/share/x` becomes `file://server/share/x`.
    match slashed.strip_prefix("//") {
        Some(unc) => format!("file://{}", encode(unc, encoded)),
        None => format!("file://{}", encode(&slashed, encoded)),
    }
}

/// Node `fileURLToPath`, or `None` where it throws: not a `file:` URI, a host on POSIX, an encoded separator, or an
/// escape that does not decode to UTF-8.
pub(crate) fn path_of(uri: &str, windows: bool) -> Option<String> {
    let rest = uri
        .get(..7)?
        .eq_ignore_ascii_case("file://")
        .then(|| &uri[7..])?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let decoded = decode(path)?;
    if !windows {
        if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
            return None;
        }
        if path.to_ascii_lowercase().contains("%2f") {
            return None;
        }
        return Some(decoded);
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return None;
    }
    let windows_path = decoded.replace('/', "\\");
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return Some(format!("\\\\{}{windows_path}", unc_host(host)?));
    }
    let without_slash = windows_path.strip_prefix('\\')?;
    let bytes = without_slash.as_bytes();
    (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        .then(|| without_slash.to_owned())
}

/// The URL parser's host of a `file:` URL: percent-decoded, ASCII-lowercased, and invalid (Node throws) when it holds
/// a forbidden domain code point.
fn unc_host(host: &str) -> Option<String> {
    let decoded = decode(host)?;
    let forbidden = |c: char| {
        c.is_ascii_control()
            || matches!(
                c,
                ' ' | '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
            )
    };
    (!decoded.chars().any(forbidden)).then(|| decoded.to_ascii_lowercase())
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            // Two hex digits exactly, as `decodeURIComponent`: `from_str_radix` would also take a sign.
            let high = hex_digit(*bytes.get(at + 1)?)?;
            let low = hex_digit(*bytes.get(at + 2)?)?;
            out.push(high << 4 | low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

/// Node `normalizeFileUri`: decode to a path and encode again; a URI that does not decode keeps its spelling. A
/// Windows drive letter is lowercased either way.
pub(crate) fn normalize(uri: &str, windows: bool) -> String {
    let canonical =
        path_of(uri, windows).map_or_else(|| uri.to_owned(), |path| document_uri(&path, windows));
    lowercase_drive(&canonical)
}

fn lowercase_drive(uri: &str) -> String {
    let Some(rest) = uri.strip_prefix("file:///") else {
        return uri.to_owned();
    };
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("file:///{}{}", rest[..1].to_ascii_lowercase(), &rest[1..]);
    }
    uri.to_owned()
}

#[cfg(test)]
#[path = "uri_tests.rs"]
mod tests;
