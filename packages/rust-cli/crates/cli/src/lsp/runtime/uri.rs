//! Fork: `file:` URIs for language servers (specs/fork-rust-lsp.md "Pool", URIs). Root and workspace folders follow
//! Node adapters `lsp/paths.ts` `filePathToFileUri`; documents follow core `lsp/uri.ts` (`pathToFileURL`, then a
//! lowercase drive letter). A URI a server sends is matched after decoding it to a path and encoding it again.

/// The bytes Node's `pathToFileURL` percent-encodes in a path (checked against Node 26): every C0 control
/// (U+0000–U+001F), space and `"#%<>?[\]^`{|}~`, DEL, and every non-ASCII byte.
fn document_byte_encoded(byte: u8, windows: bool) -> bool {
    match byte {
        0x00..=0x1f
        | b' '
        | b'"'
        | b'#'
        | b'%'
        | b'<'
        | b'>'
        | b'?'
        | b'['
        | b']'
        | b'^'
        | b'`'
        | b'{'
        | b'|'
        | b'}'
        | b'~'
        | 0x7f => true,
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

/// What Node's `fileURLToPath` throws: the error's `code` (`URIError` for a malformed escape, which has none) and its
/// message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UriError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl UriError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn malformed() -> Self {
        Self::new("URIError", "URI malformed")
    }
}

/// Node `process.platform` for the host check's message.
pub(crate) fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node `fileURLToPath` (lib/internal/url.js): the WHATWG URL parser, then `getPathFromURLPosix` or
/// `getPathFromURLWin32`, in Node's order of checks.
pub(crate) fn path_of(uri: &str, windows: bool) -> Result<String, UriError> {
    let url = url::Url::parse(uri).map_err(|_| UriError::new("ERR_INVALID_URL", "Invalid URL"))?;
    if url.scheme() != "file" {
        return Err(UriError::new(
            "ERR_INVALID_URL_SCHEME",
            "The URL must be of scheme file",
        ));
    }
    // The parser turns a `localhost` host into the empty one.
    let host = url.host_str().unwrap_or("");
    let pathname = drive_colon(url.path());
    let pathname = pathname.as_str();
    if !windows {
        if !host.is_empty() {
            return Err(UriError::new(
                "ERR_INVALID_FILE_URL_HOST",
                format!(
                    "File URL host must be \"localhost\" or empty on {}",
                    node_platform()
                ),
            ));
        }
        if encoded_separator(pathname, false) {
            return Err(UriError::new(
                "ERR_INVALID_FILE_URL_PATH",
                "File URL path must not include encoded / characters",
            ));
        }
        return decode(pathname).ok_or_else(UriError::malformed);
    }
    if encoded_separator(pathname, true) {
        return Err(UriError::new(
            "ERR_INVALID_FILE_URL_PATH",
            "File URL path must not include encoded \\ or / characters",
        ));
    }
    let path = decode(&pathname.replace('/', "\\")).ok_or_else(UriError::malformed)?;
    if !host.is_empty() {
        return Ok(format!("\\\\{host}{path}"));
    }
    let bytes = path.as_bytes();
    if bytes.len() < 3 || !bytes[1].is_ascii_alphabetic() || bytes[2] != b':' {
        return Err(UriError::new(
            "ERR_INVALID_FILE_URL_PATH",
            "File URL path must be absolute",
        ));
    }
    Ok(path[1..].to_owned())
}

/// The WHATWG parser normalizes a first segment `X|` (a Windows drive letter) to `X:`; the `url` crate keeps it.
fn drive_colon(pathname: &str) -> String {
    let bytes = pathname.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'|'
        && bytes.get(3).is_none_or(|next| *next == b'/');
    if drive {
        format!("{}:{}", &pathname[..2], &pathname[3..])
    } else {
        pathname.to_owned()
    }
}

/// `%2F` (and on Windows `%5C`) in either case.
fn encoded_separator(pathname: &str, windows: bool) -> bool {
    let lower = pathname.to_ascii_lowercase();
    lower.contains("%2f") || (windows && lower.contains("%5c"))
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
        path_of(uri, windows).map_or_else(|_| uri.to_owned(), |path| document_uri(&path, windows));
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
