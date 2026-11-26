use super::*;

#[test]
fn feedback_words_round_trip() {
    for feedback in [Feedback::Like, Feedback::Dislike] {
        assert_eq!(Feedback::parse(feedback.as_str()), Some(feedback));
    }
    assert_eq!(Feedback::parse("meh"), None);
}

#[test]
fn marks_apply_one_change_at_a_time() {
    let marks = Marks::default()
        .with(Mark::Feedback(Some(Feedback::Like)))
        .with(Mark::Pinned(Some(7)));
    assert_eq!(marks.feedback, Some(Feedback::Like));
    assert_eq!(marks.pinned_at, Some(7));
    assert!(!marks.is_empty());
    let marks = marks
        .with(Mark::Feedback(Some(Feedback::Dislike)))
        .with(Mark::Pinned(None));
    assert_eq!(marks.feedback, Some(Feedback::Dislike));
    assert_eq!(marks.pinned_at, None);
    assert!(marks.with(Mark::Feedback(None)).is_empty());
}

#[test]
fn mark_serializes_as_a_tagged_value() {
    let value = serde_json::to_value(Mark::Pinned(Some(5))).unwrap();
    assert_eq!(value, serde_json::json!({"mark": "pinned", "value": 5}));
    let back: Mark = serde_json::from_value(value).unwrap();
    assert_eq!(back, Mark::Pinned(Some(5)));
}
