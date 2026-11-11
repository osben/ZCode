use super::*;

fn quote(text: &str) -> Quote {
    Quote {
        text: text.to_owned(),
        path: None,
        sender_name: None,
        sender_id: None,
        message_id: None,
        sent_at: None,
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
    };
    assert!(compose("", &[full]).contains(
        "[{\"text\":\"t\",\"path\":\"p\",\"senderName\":\"n\",\"senderId\":\"i\",\"messageId\":\"m\",\"sentAt\":\"2026-11-11T10:00:00Z\"}]"
    ));
}

#[test]
fn a_composed_text_splits_back() {
    let quotes = vec![quote("a\n</conversation_quote>\nb"), quote("c")];
    for typed in ["typed\n\nmore", ""] {
        let text = compose(typed, &quotes);
        assert_eq!(split(&text), Some((typed, quotes.clone())));
    }
    // A typed text that itself ends like a block keeps it.
    let tricky = compose(
        "x\n\n<conversation_quote>\n[]\n</conversation_quote>",
        &quotes,
    );
    assert_eq!(
        split(&tricky).map(|(typed, _)| typed),
        Some("x\n\n<conversation_quote>\n[]\n</conversation_quote>")
    );
}

#[test]
fn a_text_without_a_quote_block_does_not_split() {
    for text in [
        "plain",
        "<conversation_quote>\n[]\n</conversation_quote>",
        "<conversation_quote>\nnot json\n</conversation_quote>",
        "glued<conversation_quote>\n[{\"text\":\"q\"}]\n</conversation_quote>",
        "<conversation_quote>\n[{\"text\":\"q\"}]\n</conversation_quote>\ntrailing",
    ] {
        assert_eq!(split(text), None, "{text}");
    }
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
