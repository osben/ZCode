//! Fork: the v4 query `v4/conversation/inputPrediction`, the phone's ghost hint (Node bootstrap
//! `input-prediction-handler.ts` and core `input-prediction-sidecar.ts`; specs/fork-rust-input-prediction.md).
//!
//! Owner: [`Handler`] keeps the in-flight prediction per session and the result cache. The session's turns and the
//! model call come through [`Backend`] (production: the [`Server`]), so the tests script both. The model call is one
//! workspace-scoped side request on the session's selection (fork/workspace_model.rs helpers); nothing is written to
//! the session.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use rust_cli_kernel_api::model::{ApiMessage, ModelRequest, ModelSelection, SystemBlock};
use rust_cli_kernel_api::side_request::{Requester, SideSource};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::workspace_model::{
    AUXILIARY_MAX_OUTPUT, UNKNOWN_MAX_OUTPUT, Wanted, budgeted, capped, entry, limit,
    run_cancellable, selection, tokens,
};
use crate::server::Server;

/// Node `INPUT_PREDICTION_MODEL_TIMEOUT_MS`: a ghost hint that arrives late is worth nothing.
const MODEL_TIMEOUT: Duration = Duration::from_secs(20);
const CONTEXT_TURNS: usize = 6;
const ASSISTANT_MAX_UNITS: usize = 800;
const CONTEXT_MAX_UNITS: usize = 6_000;
const CONFIDENCE_THRESHOLD: f64 = 0.8;
const NEXT_INPUT_MIN_TURNS: usize = 2;
const DRAFT_MIN_TURNS: usize = 1;
/// Only the last 2 real user inputs are checked for a repeat.
const DEDUPE_RECENT: usize = 2;
const MAX_CANDIDATES: usize = 3;
/// UTF-16 units of one candidate's text (the wire schema counts UTF-16).
const MAX_TEXT_UNITS: usize = 40;
const MAX_DRAFT_UNITS: usize = 4_000;
const MAX_REQUEST_ID_UNITS: usize = 128;
const CACHE_ENTRIES: usize = 16;

const OUTPUT_FORMAT_RULE: &str = "- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字：\n{\"candidates\":[{\"text\":\"...\",\"confidence\":0.0},{\"text\":\"...\",\"confidence\":0.0},{\"text\":\"...\",\"confidence\":0.0}]}";

const CONFIDENCE_RULE: &str = "- 每个候选带 confidence（0 到 1 的小数）：你对\"用户真的会这样写\"的把握。三个候选的置信度要拉开差距；校准比乐观重要，拿不准就给低分。";

/// The draft is empty: predict the next whole input.
fn next_input_system_prompt() -> String {
    format!(
        "你是输入预测器。根据下面的多轮对话上下文，预测这位用户下一条可能发送的输入。\n\n这是预测任务，不是对话。绝不要回答、执行或延续对话内容；只输出预测结果。\n\n规则：\n- 恰好生成 3 个候选，按把握从高到低排列。\n- 每个候选是一句用户自己会说的话（追问、指令、确认等语气），单行，不超过 {MAX_TEXT_UNITS} 个字，语言与用户一致，不要像助手的回复。\n{CONFIDENCE_RULE}\n{OUTPUT_FORMAT_RULE}"
    )
}

/// The draft is not empty: predict what follows it.
fn draft_system_prompt() -> String {
    format!(
        "你是输入补全器。根据下面的多轮对话上下文和用户正在输入的草稿，预测用户接下来要在草稿后面接着写的内容。\n\n这是补全任务，不是对话。绝不要回答、执行或延续对话内容；只输出补全结果。\n\n规则：\n- 恰好生成 3 个候选，按把握从高到低排列。\n- text 只写接在草稿末尾之后的新内容，不要重复草稿本身；单行，不超过 {MAX_TEXT_UNITS} 个字，语言与草稿一致。\n- 如果草稿末尾是半个词，text 从这个词剩下的部分开始写。\n{CONFIDENCE_RULE}\n{OUTPUT_FORMAT_RULE}"
    )
}

/// One real user input and the assistant's last text answer to it.
#[derive(Clone)]
pub(crate) struct Turn {
    pub(crate) user_text: String,
    pub(crate) assistant_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Candidate {
    pub(crate) text: String,
    pub(crate) confidence: f64,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Decision {
    Show,
    SuppressBelowThreshold,
    SuppressNoContext,
    Unavailable,
    Cancelled,
}

impl Decision {
    fn wire(self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::SuppressBelowThreshold => "suppress_below_threshold",
            Self::SuppressNoContext => "suppress_no_context",
            Self::Unavailable => "unavailable",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Outcome {
    pub(crate) decision: Decision,
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) top_confidence: f64,
}

impl Outcome {
    fn empty(decision: Decision) -> Self {
        Self {
            decision,
            candidates: Vec::new(),
            top_confidence: 0.0,
        }
    }

    fn render(&self, request_id: Option<&str>) -> Value {
        let mut result = json!({
            "decision": self.decision.wire(),
            "candidates": self
                .candidates
                .iter()
                .map(|candidate| json!({"text": candidate.text, "confidence": candidate.confidence}))
                .collect::<Vec<_>>(),
            "topConfidence": self.top_confidence,
        });
        if let Some(id) = request_id {
            result["requestId"] = json!(id);
        }
        result
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// A blank draft is no draft.
pub(crate) fn normalize_draft(draft: &str) -> String {
    if draft.trim().is_empty() {
        String::new()
    } else {
        draft.to_owned()
    }
}

/// The real user inputs a mode needs before the model is asked.
pub(crate) fn min_turns(draft: &str) -> usize {
    if draft.is_empty() {
        NEXT_INPUT_MIN_TURNS
    } else {
        DRAFT_MIN_TURNS
    }
}

/// The text kept within `max` UTF-16 units from the start, never splitting a surrogate pair.
fn head_units(text: &str, max: usize) -> String {
    let mut kept = String::new();
    let mut units = 0;
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        kept.push(c);
    }
    kept
}

pub(crate) fn build_context(turns: &[Turn]) -> String {
    build_context_with(turns, CONTEXT_TURNS, ASSISTANT_MAX_UNITS, CONTEXT_MAX_UNITS)
}

/// The last turns, the user's text whole and the reply cut; the whole is cut from its start when over budget (the
/// newest context stays).
pub(crate) fn build_context_with(
    turns: &[Turn],
    max_turns: usize,
    assistant_max: usize,
    total_max: usize,
) -> String {
    let start = turns.len().saturating_sub(max_turns);
    let blocks: Vec<String> = turns[start..]
        .iter()
        .map(|turn| {
            let assistant = turn.assistant_text.as_deref().unwrap_or("");
            let bounded = if utf16_len(assistant) > assistant_max {
                format!("{}…", head_units(assistant, assistant_max))
            } else {
                assistant.to_owned()
            };
            let shown = if bounded.is_empty() {
                "（无回复）"
            } else {
                &bounded
            };
            format!("用户：{}\n助手：{shown}", turn.user_text)
        })
        .collect();
    let text = blocks.join("\n\n");
    let total = utf16_len(&text);
    if total <= total_max {
        return text;
    }
    // Drop whole characters from the start until the rest fits.
    let mut excess = total - total_max;
    let mut chars = text.chars();
    while excess > 0 {
        match chars.next() {
            Some(c) => excess = excess.saturating_sub(c.len_utf16()),
            None => break,
        }
    }
    chars.as_str().to_owned()
}

/// The model input: the system prompt and the one user message (the draft is appended in completion mode).
pub(crate) fn build_messages(turns: &[Turn], draft: &str) -> (String, String) {
    let context = build_context(turns);
    if draft.is_empty() {
        (next_input_system_prompt(), context)
    } else {
        (
            draft_system_prompt(),
            format!("{context}\n\n【用户正在输入的草稿】\n{draft}"),
        )
    }
}

/// Removes every `<think>...</think>` block, matching the tags without regard to case; an unclosed tag stays.
fn strip_think(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(open) = lower[at..].find("<think>") {
        let open = at + open;
        let Some(close) = lower[open + "<think>".len()..].find("</think>") else {
            break;
        };
        out.push_str(&raw[at..open]);
        at = open + "<think>".len() + close + "</think>".len();
    }
    out.push_str(&raw[at..]);
    out
}

fn try_parse_candidates(text: &str) -> Option<Vec<Candidate>> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let candidates = parsed.as_object()?.get("candidates")?.as_array()?;
    let mut result = Vec::new();
    for candidate in candidates {
        let Some(object) = candidate.as_object() else {
            continue;
        };
        if let (Some(text), Some(confidence)) = (
            object.get("text").and_then(Value::as_str),
            object.get("confidence").and_then(Value::as_f64),
        ) {
            result.push(Candidate {
                text: text.to_owned(),
                confidence,
            });
        }
    }
    Some(result)
}

/// The fenced body (an optional `json` tag, the opening line, up to the closing fence) when the whole text is one
/// code fence.
fn fenced_body(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("```")?.strip_suffix("```")?;
    let rest = rest.trim_start_matches([' ', '\t']);
    let rest = match rest.get(..4) {
        Some(tag) if tag.eq_ignore_ascii_case("json") => &rest[4..],
        _ => rest,
    };
    let rest = rest.trim_start_matches([' ', '\t']);
    rest.strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
}

/// A comma before a closing bracket or brace goes (`,\s*([}\]])`).
fn without_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == ',' {
            let mut next = index + 1;
            while next < chars.len() && chars[next].is_whitespace() {
                next += 1;
            }
            if next < chars.len() && matches!(chars[next], '}' | ']') {
                index = next;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn strip_json_artifacts(text: &str) -> String {
    let candidate = fenced_body(text).unwrap_or(text).trim();
    let candidate = without_trailing_commas(candidate);
    match (candidate.find('{'), candidate.rfind('}')) {
        (Some(first), Some(last)) if last > first => candidate[first..=last].to_owned(),
        _ => candidate,
    }
}

/// The model's candidates, or None when the reply has none usable (JSON cleaned of think blocks, fences, trailing
/// commas and prose around the object).
pub(crate) fn parse_response(raw: &str) -> Option<Vec<Candidate>> {
    let without_thinking = strip_think(raw);
    let without_thinking = without_thinking.trim();
    let parsed = try_parse_candidates(without_thinking)
        .or_else(|| try_parse_candidates(&strip_json_artifacts(without_thinking)))?;
    let cleaned: Vec<Candidate> = parsed
        .into_iter()
        .filter(|candidate| !candidate.text.is_empty() && candidate.confidence.is_finite())
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// A candidate as the text that follows the draft: one line, the repeated draft removed, the end trimmed (the start
/// only when the draft ends in whitespace), cut to 40 UTF-16 units.
pub(crate) fn to_suffix(raw: &str, draft: &str) -> String {
    let mut text = String::new();
    let mut in_break = false;
    for c in raw.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                text.push(' ');
            }
            in_break = true;
        } else {
            in_break = false;
            text.push(c);
        }
    }
    let mut text = if draft.is_empty() {
        text.trim().to_owned()
    } else {
        let trimmed_draft = draft.trim_end();
        let mut rest = text.as_str();
        if let Some(after) = rest.strip_prefix(draft) {
            rest = after;
        } else if !trimmed_draft.is_empty()
            && let Some(after) = rest.strip_prefix(trimmed_draft)
        {
            rest = after;
        }
        let rest = rest.trim_end();
        if draft.ends_with(char::is_whitespace) {
            rest.trim_start().to_owned()
        } else {
            rest.to_owned()
        }
    };
    if utf16_len(&text) <= MAX_TEXT_UNITS {
        return text;
    }
    text = head_units(&text, MAX_TEXT_UNITS);
    text.trim_end().to_owned()
}

/// Repeat check key: lowercase, all whitespace removed.
fn dedupe_key(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// The post filter and the decision (specs rules 5 and 9).
pub(crate) fn decide(
    raw: &[Candidate],
    draft: &str,
    recent_inputs: &[String],
    turn_count: usize,
) -> Outcome {
    if turn_count < min_turns(draft) {
        return Outcome::empty(Decision::SuppressNoContext);
    }
    let from = recent_inputs.len().saturating_sub(DEDUPE_RECENT);
    let recent: Vec<String> = recent_inputs[from..]
        .iter()
        .map(|text| dedupe_key(text))
        .collect();
    // Insertion order is kept for equal confidence, like a JS Map.
    let mut kept: Vec<(String, Candidate)> = Vec::new();
    for candidate in raw {
        let confidence = candidate.confidence.clamp(0.0, 1.0);
        let text = to_suffix(&candidate.text, draft);
        if text.trim().is_empty() {
            continue;
        }
        let key = dedupe_key(&format!("{draft}{text}"));
        if recent.contains(&key) {
            continue;
        }
        match kept.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, existing)) if existing.confidence < confidence => {
                *existing = Candidate { text, confidence };
            }
            Some(_) => {}
            None => kept.push((key, Candidate { text, confidence })),
        }
    }
    let mut candidates: Vec<Candidate> = kept.into_iter().map(|(_, candidate)| candidate).collect();
    candidates.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    candidates.truncate(MAX_CANDIDATES);
    let top_confidence = candidates
        .first()
        .map_or(0.0, |candidate| candidate.confidence);
    let decision = if !candidates.is_empty() && top_confidence >= CONFIDENCE_THRESHOLD {
        Decision::Show
    } else {
        Decision::SuppressBelowThreshold
    };
    Outcome {
        decision,
        candidates,
        top_confidence,
    }
}

fn text_of(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// A real user input: a human message that is not a tool result (Node `isConversationRealUserTurnStarter`).
fn is_real_user(message: &Message) -> bool {
    matches!(message, Message::User(user) if user.origin == UserOrigin::Human
        && !user.content.iter().any(|block| matches!(block, ContentBlock::ToolResult { .. })))
}

/// Pairs each real user input with the last non-empty assistant text before the next real user input. Meta rows,
/// attachments, summaries and tool results neither start a turn nor end one.
pub(crate) fn collect_turns(messages: &[Message]) -> Vec<Turn> {
    let mut turns = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let Message::User(user) = message else {
            continue;
        };
        if !is_real_user(message) {
            continue;
        }
        let user_text = text_of(&user.content);
        if user_text.trim().is_empty() {
            continue;
        }
        let mut assistant_text = None;
        for next in &messages[index + 1..] {
            if is_real_user(next) {
                break;
            }
            if let Message::Assistant(reply) = next {
                let text = text_of(&reply.content);
                if !text.trim().is_empty() {
                    assistant_text = Some(text);
                }
            }
        }
        turns.push(Turn {
            user_text,
            assistant_text,
        });
    }
    turns
}

/// What a prediction needs from a session: its turns, and the model to ask (None: the session has no selection).
pub(crate) struct Material {
    pub(crate) turns: Vec<Turn>,
    pub(crate) model: Option<ModelSelection>,
}

#[async_trait]
pub(crate) trait Backend: Send + Sync {
    /// None when the session is not resident in this process.
    async fn material(&self, session: &SessionId) -> Result<Option<Material>, String>;

    /// One non-streaming call on `model`; the error text is for the log only.
    async fn complete(
        &self,
        session: &SessionId,
        model: &ModelSelection,
        system: &str,
        user: &str,
        cancel: CancellationToken,
    ) -> Result<String, String>;
}

#[async_trait]
impl Backend for Server {
    async fn material(&self, session: &SessionId) -> Result<Option<Material>, String> {
        // Never opens a cold session: the phone watches a resident one.
        let Some(live) = self.bridge.get(session) else {
            return Ok(None);
        };
        let view = live
            .handle
            .view()
            .await
            .map_err(|error| error.to_string())?;
        Ok(Some(Material {
            turns: collect_turns(&view.messages),
            model: Some(view.selection),
        }))
    }

    async fn complete(
        &self,
        session: &SessionId,
        model: &ModelSelection,
        system: &str,
        user: &str,
        cancel: CancellationToken,
    ) -> Result<String, String> {
        let wanted = Wanted {
            provider: model.provider.clone(),
            model: model.model.clone(),
            reasoning: None,
        };
        let found = entry(&self.context, &wanted)
            .await
            .map_err(|error| error.message)?;
        // Node `auxiliaryModelOptions`: the lowest reasoning tier and min(5000, the model's limit).
        let level = found.reasoning_levels.first().cloned();
        let request = ModelRequest::side(
            selection(&found, level),
            SideSource::InputPrediction,
            vec![SystemBlock {
                text: system.to_owned(),
                cache_control: None,
            }],
            vec![ApiMessage::user_text(user.to_owned())],
            limit(&found).map_or(UNKNOWN_MAX_OUTPUT, tokens),
            Requester {
                session: session.clone(),
                run: None,
                agent: None,
            },
        );
        let request = budgeted(request, Some(capped(&found, AUXILIARY_MAX_OUTPUT)));
        let collected = run_cancellable(self, request, cancel, false)
            .await
            .map_err(|error| error.message)?;
        if !collected.finished {
            return Err("the model reply ended before its stop".to_owned());
        }
        Ok(collected.text())
    }
}

/// The in-flight prediction per session (a generation tells a finished call from the one that replaced it) and the
/// cache of settled results.
#[derive(Default)]
pub(crate) struct Handler {
    generation: AtomicU64,
    in_flight: Mutex<HashMap<String, (u64, CancellationToken)>>,
    cache: Mutex<VecDeque<(String, Outcome)>>,
}

/// Forgets the call's in-flight entry when it ends (also when the request future is dropped), unless a newer call
/// of the session has taken the slot.
struct InFlight<'a> {
    handler: &'a Handler,
    session: String,
    generation: u64,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut table = self.handler.in_flight.lock_unpoisoned();
        if table
            .get(&self.session)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            table.remove(&self.session);
        }
    }
}

/// `v4ConversationInputPredictionParamsSchema` (strict).
struct Params {
    session: SessionId,
    revision: u64,
    draft: String,
    request_id: Option<String>,
}

fn parse_params(value: &Value) -> Result<Params, RpcError> {
    let bad =
        |what: &str| RpcError::invalid_params(format!("Invalid inputPrediction params: {what}"));
    let object = value
        .as_object()
        .ok_or_else(|| bad("an object is required"))?;
    if let Some(key) = object.keys().find(|key| {
        !matches!(
            key.as_str(),
            "sessionId" | "revision" | "draft" | "requestId"
        )
    }) {
        return Err(bad(&format!("unknown key {key}")));
    }
    let session = object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| bad("sessionId is required"))?;
    // A JSON number with no fraction is an integer, as in JavaScript.
    let revision = object
        .get("revision")
        .and_then(|revision| {
            revision.as_u64().or_else(|| {
                revision
                    .as_f64()
                    .filter(|number| *number >= 0.0 && number.fract() == 0.0 && *number < 9e15)
                    .map(|number| number as u64)
            })
        })
        .ok_or_else(|| bad("revision must be a non-negative integer"))?;
    let draft = match object.get("draft") {
        None => "",
        Some(Value::String(draft)) if utf16_len(draft) <= MAX_DRAFT_UNITS => draft,
        Some(_) => return Err(bad("draft must be a string of at most 4000 characters")),
    };
    let request_id = match object.get("requestId") {
        None => None,
        Some(Value::String(id)) if (1..=MAX_REQUEST_ID_UNITS).contains(&utf16_len(id)) => {
            Some(id.clone())
        }
        Some(_) => return Err(bad("requestId must be 1 to 128 characters")),
    };
    Ok(Params {
        session: SessionId::new(session),
        revision,
        draft: normalize_draft(draft),
        request_id,
    })
}

impl Handler {
    pub(crate) async fn handle(
        &self,
        backend: &dyn Backend,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params = parse_params(params)?;
        let request_id = params.request_id.as_deref();
        let cache_key = json!([params.session.as_str(), params.revision, params.draft]).to_string();
        if let Some(hit) = self.cached(&cache_key) {
            return Ok(hit.render(request_id));
        }

        // A newer request replaces the session's older one: the phone only cares about the latest draft.
        let token = CancellationToken::new();
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let older = self.in_flight.lock_unpoisoned().insert(
            params.session.as_str().to_owned(),
            (generation, token.clone()),
        );
        if let Some((_, older)) = older {
            older.cancel();
        }
        let _slot = InFlight {
            handler: self,
            session: params.session.as_str().to_owned(),
            generation,
        };

        let outcome = self.predict(backend, &params, &token).await;
        if token.is_cancelled() {
            return Ok(Outcome::empty(Decision::Cancelled).render(request_id));
        }
        if outcome.decision != Decision::Unavailable {
            self.remember(cache_key, outcome.clone());
        }
        Ok(outcome.render(request_id))
    }

    fn cached(&self, key: &str) -> Option<Outcome> {
        let mut cache = self.cache.lock_unpoisoned();
        let at = cache.iter().position(|(cached, _)| cached == key)?;
        // Touch: the hit becomes the newest.
        let entry = cache.remove(at)?;
        let outcome = entry.1.clone();
        cache.push_back(entry);
        Some(outcome)
    }

    fn remember(&self, key: String, outcome: Outcome) {
        let mut cache = self.cache.lock_unpoisoned();
        cache.retain(|(cached, _)| *cached != key);
        cache.push_back((key, outcome));
        while cache.len() > CACHE_ENTRIES {
            cache.pop_front();
        }
    }

    async fn predict(
        &self,
        backend: &dyn Backend,
        params: &Params,
        token: &CancellationToken,
    ) -> Outcome {
        let session = &params.session;
        let draft = params.draft.as_str();
        let material = match backend.material(session).await {
            Ok(material) => material,
            Err(error) => {
                warn("transcript_failed", session, &error);
                return Outcome::empty(Decision::Unavailable);
            }
        };
        let Some(material) = material.filter(|found| found.turns.len() >= min_turns(draft)) else {
            return Outcome::empty(Decision::SuppressNoContext);
        };
        let Some(model) = material.model.as_ref() else {
            return Outcome::empty(Decision::Unavailable);
        };

        let (system, user) = build_messages(&material.turns, draft);
        // The call gets its own token so the 20 s limit stops it without marking the whole request cancelled.
        let call = token.child_token();
        let reply = tokio::select! {
            biased;
            // The wait ends at once on an abort, even if the model port never looks at its token.
            () = token.cancelled() => Err("superseded".to_owned()),
            () = tokio::time::sleep(MODEL_TIMEOUT) => Err("the model call timed out".to_owned()),
            reply = backend.complete(session, model, &system, &user, call.clone()) => reply,
        };
        call.cancel();
        let text = match reply {
            Ok(text) => text,
            Err(error) => {
                // A replaced request is not an error and logs nothing.
                if !token.is_cancelled() {
                    warn("model_failed", session, &error);
                }
                return Outcome::empty(Decision::Unavailable);
            }
        };
        let Some(raw) = parse_response(&text) else {
            return Outcome::empty(Decision::SuppressBelowThreshold);
        };
        let recent: Vec<String> = material
            .turns
            .iter()
            .map(|turn| turn.user_text.clone())
            .collect();
        decide(&raw, draft, &recent, material.turns.len())
    }
}

/// Only the event, the session and the error text: never the draft or any conversation text.
fn warn(reason: &str, session: &SessionId, error: &str) {
    tracing::warn!(
        event = format!("zcode_protocol.v4.input_prediction_{reason}"),
        session = session.as_str(),
        error = error,
        "v4 input prediction degraded"
    );
}

pub(crate) async fn handle(server: &Server, params: &Value) -> Result<Value, RpcError> {
    server.input_prediction.handle(server, params).await
}

#[cfg(test)]
#[path = "input_prediction_tests.rs"]
mod tests;
