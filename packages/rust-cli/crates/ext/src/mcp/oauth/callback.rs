//! Loopback callback target check (Node `localhost-callback.ts`). The listener itself is the
//! runtime's [`super::LoopbackListener`]; this module decides whether one request target is the
//! authorization response, so the check can be tested without a socket.

use url::form_urlencoded;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackError {
    /// Another path (for example a favicon request): not an error, the listener keeps waiting.
    NotCallbackPath,
    /// `state` is missing or differs: a stray or forged request. The listener keeps waiting.
    StateMismatch,
    /// The authorization server reported an error (for example `access_denied`).
    Denied(String),
    MissingCode,
}

/// Check one request target (`/path?query`) against the callback path and the expected `state`.
/// The state is checked before the error parameter, so a forged error cannot end the flow.
pub fn parse_callback_target(
    target: &str,
    callback_path: &str,
    expected_state: &str,
) -> Result<CallbackParams, CallbackError> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != callback_path {
        return Err(CallbackError::NotCallbackPath);
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Err(CallbackError::StateMismatch);
    }
    if let Some(error) = error {
        return Err(CallbackError::Denied(error));
    }
    match code {
        Some(code) if !code.is_empty() => Ok(CallbackParams { code }),
        _ => Err(CallbackError::MissingCode),
    }
}
