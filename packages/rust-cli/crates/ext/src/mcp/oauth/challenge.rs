//! `WWW-Authenticate` challenge parser for the Bearer scheme (RFC 6750 section 3), reading the parameters the
//! OAuth flow uses: `error` (`insufficient_scope`), `scope` and `resource_metadata` (RFC 9728).

/// The parameters of a Bearer challenge that the OAuth flow uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub error: Option<String>,
    pub scope: Option<String>,
    pub resource_metadata: Option<String>,
}

/// Parse the Bearer challenge of a `WWW-Authenticate` header. `None` when the header has no Bearer challenge.
pub fn parse_www_authenticate(header: &str) -> Option<Challenge> {
    let params = bearer_params(header.trim_start())?;
    let value = |name: &str| {
        params
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.clone())
    };
    Some(Challenge {
        error: value("error"),
        scope: value("scope"),
        resource_metadata: value("resource_metadata"),
    })
}

/// The text after the `Bearer` scheme name, when the header starts with it (case-insensitive, followed by
/// whitespace or the end), parsed into `(name, value)` pairs.
fn bearer_params(header: &str) -> Option<Vec<(String, String)>> {
    let scheme = header.get(..6)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &header[6..];
    if !rest.is_empty() && !rest.starts_with(|c: char| c.is_ascii_whitespace()) {
        return None;
    }
    Some(parse_params(rest))
}

/// `name=value` pairs separated by commas. A value is a quoted string (with `\` escapes) or a bare token.
fn parse_params(text: &str) -> Vec<(String, String)> {
    let mut params = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace() || *c == ',').is_some() {}
        let mut name = String::new();
        while let Some(c) = chars.next_if(|c| *c != '=' && *c != ',') {
            name.push(c);
        }
        if chars.next_if_eq(&'=').is_none() {
            if chars.peek().is_none() {
                break;
            }
            continue;
        }
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        let mut value = String::new();
        if chars.next_if_eq(&'"').is_some() {
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        if let Some(escaped) = chars.next() {
                            value.push(escaped);
                        }
                    }
                    '"' => break,
                    other => value.push(other),
                }
            }
        } else {
            while let Some(c) = chars.next_if(|c| *c != ',' && !c.is_whitespace()) {
                value.push(c);
            }
        }
        params.push((name.trim().to_owned(), value));
        if chars.peek().is_none() {
            break;
        }
    }
    params
}
