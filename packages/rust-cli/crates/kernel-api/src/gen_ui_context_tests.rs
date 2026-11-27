use super::strip_legacy_tail;

const TAIL: &str = "\n\n<untrusted_gen_ui_state>\n[{\"path\":\"/work/page.html\",\"state\":{\"a\":1}}]\n</untrusted_gen_ui_state>";

#[test]
fn a_valid_legacy_tail_is_removed() {
    let text = format!("look at this{TAIL}");
    assert_eq!(strip_legacy_tail(&text), Some("look at this"));
}

#[test]
fn trailing_white_space_after_the_tail_is_allowed() {
    let text = format!("hi{TAIL}  \n\t");
    assert_eq!(strip_legacy_tail(&text), Some("hi"));
}

#[test]
fn an_empty_context_is_a_valid_tail() {
    let text = "hi\n\n<untrusted_gen_ui_state>\n[]\n</untrusted_gen_ui_state>";
    assert_eq!(strip_legacy_tail(text), Some("hi"));
}

#[test]
fn a_tail_that_is_not_at_the_end_stays() {
    let text = format!("{TAIL} and more");
    assert_eq!(strip_legacy_tail(&text), None);
}

#[test]
fn broken_json_stays_in_the_text() {
    let text = "x\n\n<untrusted_gen_ui_state>\n[{oops\n</untrusted_gen_ui_state>";
    assert_eq!(strip_legacy_tail(text), None);
}

#[test]
fn an_entry_that_fails_the_schema_stays() {
    for body in [
        "{\"path\":\"/a/b.html\"}",
        "[{\"path\":\"relative.html\",\"state\":1}]",
        "[{\"path\":\"/a/b.html\",\"state\":1,\"extra\":2}]",
        "[{\"state\":1}]",
    ] {
        let text = format!("x\n\n<untrusted_gen_ui_state>\n{body}\n</untrusted_gen_ui_state>");
        assert_eq!(strip_legacy_tail(&text), None, "{body}");
    }
}

#[test]
fn the_leftmost_opening_is_the_one_cut() {
    // The lazy regex starts at the first opening; its body then holds the second opening and is not JSON.
    let text = format!("a{TAIL}b{TAIL}");
    assert_eq!(strip_legacy_tail(&text), None);
}

#[test]
fn a_text_without_a_tail_is_untouched() {
    assert_eq!(strip_legacy_tail("plain"), None);
    assert_eq!(strip_legacy_tail(""), None);
}
