use super::*;

fn quote(text: &str) -> Quote {
    Quote {
        text: text.to_owned(),
        path: None,
        sender_name: None,
        sender_id: None,
        message_id: None,
        sent_at: None,
        comment: None,
        agent: None,
    }
}

#[test]
fn quotes_follow_the_typed_text_like_node() {
    let mut first = quote("E2E selection");
    first.path = Some("/w/a.ts".to_owned());
    let text = compose("hello", &[first, quote("second")]);
    // Node: `${text}\n\n<conversation_quote>\n${JSON.stringify(quotes)}\n</conversation_quote>`.
    assert_eq!(
        text,
        "hello\n\n<conversation_quote>\n[{\"text\":\"E2E selection\",\"path\":\"/w/a.ts\"},{\"text\":\"second\"}]\n</conversation_quote>"
    );
    assert_eq!(compose("hello", &[]), "hello");
    assert_eq!(
        compose("", &[quote("q")]),
        "<conversation_quote>\n[{\"text\":\"q\"}]\n</conversation_quote>"
    );
}

#[test]
fn keys_are_written_in_schema_order() {
    let full = Quote {
        text: "t".to_owned(),
        path: Some("p".to_owned()),
        sender_name: Some("n".to_owned()),
        sender_id: Some("i".to_owned()),
        message_id: Some("m".to_owned()),
        sent_at: Some("2026-11-11T10:00:00Z".to_owned()),
        comment: Some("c".to_owned()),
        agent: Some("a".to_owned()),
    };
    assert!(compose("", &[full]).contains(
        "[{\"text\":\"t\",\"path\":\"p\",\"senderName\":\"n\",\"senderId\":\"i\",\"messageId\":\"m\",\"sentAt\":\"2026-11-11T10:00:00Z\",\"comment\":\"c\",\"agent\":\"a\"}]"
    ));
}

#[test]
fn limits_match_the_app_schema() {
    assert!(validate(&vec![quote("q"); MAX_COUNT]).is_ok());
    assert!(validate(&vec![quote("q"); MAX_COUNT + 1]).is_err());
    // zod counts a quote's code points, the total in UTF-16 units.
    assert!(validate(&[quote(&"😀".repeat(MAX_TEXT_CHARS))]).is_ok());
    assert!(validate(&[quote(&"a".repeat(MAX_TEXT_CHARS + 1))]).is_err());
    assert!(validate(&[quote(&"a".repeat(8_000)), quote(&"a".repeat(8_000))]).is_ok());
    assert!(validate(&[quote(&"😀".repeat(5_000)), quote(&"a".repeat(6_001))]).is_err());
}

#[test]
fn sent_at_is_an_offset_date_time() {
    let at = |value: &str| {
        let mut q = quote("q");
        q.sent_at = Some(value.to_owned());
        validate(&[q]).is_ok()
    };
    // Same answers as zod 4 `z.string().datetime({ offset: true })`.
    for ok in [
        "2026-11-11T10:00:00Z",
        "2026-11-11T10:00:00.123+02:00",
        "2026-11-11T10:00:00.1234567890Z",
        "2026-11-11T10:00:00-23:59",
        "2028-02-29T10:00:00Z",
    ] {
        assert!(at(ok), "{ok}");
    }
    for bad in [
        "2026-11-11T10:00Z",
        "2026-11-11T10:00:00+0200",
        "2026-11-11T10:00:00+02",
        "2026-11-11 10:00:00Z",
        "2026-13-11T10:00:00Z",
        "2026-11-11T25:00:00Z",
        "2026-02-30T10:00:00Z",
        "2026-02-29T10:00:00Z",
        "2026-11-11T23:59:60Z",
        "2026-11-11T10:00:00+24:00",
        "2026-11-11t10:00:00z",
        "2026-11-11T10:00:00.Z",
    ] {
        assert!(!at(bad), "{bad}");
    }
}

/// Node `withConversationQuotes`: a quote with a non-blank comment adds `QUOTE_COMMENT_GUIDANCE` after the block.
#[test]
fn a_comment_adds_nodes_guidance_after_the_block() {
    let mut commented = quote("passage");
    commented.comment = Some("why?".to_owned());
    commented.agent = Some("Explore".to_owned());
    let block = "<conversation_quote>\n[{\"text\":\"passage\",\"comment\":\"why?\",\"agent\":\"Explore\"}]\n</conversation_quote>";
    assert_eq!(
        compose("hi", std::slice::from_ref(&commented)),
        format!("hi\n\n{block}\n\n{COMMENT_GUIDANCE}")
    );
    assert_eq!(
        compose("", std::slice::from_ref(&commented)),
        format!("{block}\n\n{COMMENT_GUIDANCE}")
    );
    // A blank comment or an agent alone adds no guidance (Node `quote.comment?.trim()`).
    let mut blank = quote("passage");
    blank.comment = Some("  ".to_owned());
    blank.agent = Some("Explore".to_owned());
    assert!(!compose("hi", &[blank]).contains(COMMENT_GUIDANCE));
}

#[test]
fn comment_and_agent_limits_match_the_app_schema() {
    let with = |comment: usize, agent: usize| {
        let mut q = quote("q");
        q.comment = Some("😀".repeat(comment));
        q.agent = Some("a".repeat(agent));
        validate(&[q])
    };
    assert!(with(MAX_COMMENT_CHARS, MAX_AGENT_CHARS).is_ok());
    assert!(with(MAX_COMMENT_CHARS + 1, 1).is_err());
    assert!(with(1, MAX_AGENT_CHARS + 1).is_err());
}

#[test]
fn the_guidance_is_nodes_sentence() {
    assert_eq!(
        COMMENT_GUIDANCE,
        "Each conversation_quote item with a `comment` field is a user annotation on that exact quoted text: treat the comment as the user's question or instruction about that passage. An `agent` field names the subagent that produced the quoted text."
    );
}

/// Node's `quote.comment?.trim()` is JS `trim`: U+FEFF is whitespace (no guidance), U+0085 is not (guidance), the
/// reverse of Rust's `str::trim`.
#[test]
fn a_blank_comment_is_blank_by_js_trim() {
    let with_comment = |comment: &str| {
        let mut q = quote("passage");
        q.comment = Some(comment.to_owned());
        compose("hi", &[q])
    };
    assert!(!with_comment("\u{feff}").contains(COMMENT_GUIDANCE));
    assert!(with_comment("\u{85}").contains(COMMENT_GUIDANCE));
}
