//! The settings of a workflow confirmation window (9.66, divergence 141): the parse of a reply's `content` (Node
//! `parseWorkflowSettingsAdjustment`), the block the ask carries, and the sentence the model reads.

use serde_json::{Value, json};

use super::*;

fn content(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

/// The reply comes from a client: a key it does not know is dropped, one of the wrong shape voids the whole reply, and a
/// reply with no known key is no adjustment. The model name is trimmed; a bound is a whole number above zero.
#[test]
fn a_reply_parses_into_the_three_state_changes_or_none() {
    assert_eq!(
        parse(&content(
            json!({"subagent_model": " deepseek-v4-pro ", "max_concurrency": 6, "other": true})
        )),
        Some(Settings {
            subagent_model: Some(Some("deepseek-v4-pro".to_owned())),
            max_concurrency: Some(Some(6)),
        })
    );
    assert_eq!(
        parse(&content(
            json!({"subagent_model": null, "max_concurrency": null})
        )),
        Some(Settings {
            subagent_model: Some(None),
            max_concurrency: Some(None),
        })
    );
    // zod `int()` takes a whole number written with a fraction part of zero.
    assert_eq!(
        parse(&content(json!({"max_concurrency": 5.0}))),
        Some(Settings {
            subagent_model: None,
            max_concurrency: Some(Some(5)),
        })
    );
    let long = "m".repeat(513);
    for bad in [
        json!({}),
        json!({"other": 1}),
        json!({"max_concurrency": 0}),
        json!({"max_concurrency": -2}),
        json!({"max_concurrency": 2.5}),
        json!({"max_concurrency": "3"}),
        json!({"subagent_model": "  "}),
        json!({"subagent_model": 7}),
        json!({"subagent_model": long}),
        // One key of the wrong shape voids the other, valid one too.
        json!({"subagent_model": "ok", "max_concurrency": 0}),
    ] {
        assert_eq!(parse(&content(bad.clone())), None, "{bad}");
    }
}

/// The block names the catalog and the default bound, and a model the call already has is overwritten, not merged.
#[test]
fn the_block_names_the_catalog_and_the_default_and_overwrites_a_forged_one() {
    assert_eq!(
        adjustable_settings(true, Some(8)),
        json!({"subagent_model": true, "concurrency_ceiling": 8})
    );
    assert_eq!(
        adjustable_settings(false, None),
        json!({"subagent_model": false})
    );
    let raw = json!({"script": "x", "adjustable_settings": {"subagent_model": true, "forged": 1}});
    let shown = with_block(None, &raw, adjustable_settings(false, Some(2)));
    assert_eq!(
        shown,
        json!({"script": "x", "adjustable_settings": {"subagent_model": false, "concurrency_ceiling": 2}})
    );
}

/// Node's wording: one half per changed setting, joined by a semicolon, the default named when known; nothing applied is
/// nothing said.
#[test]
fn the_sentence_names_only_what_the_user_changed() {
    assert_eq!(describe_adjustment(&Settings::default(), Some(4)), "");
    let both = Settings {
        subagent_model: Some(None),
        max_concurrency: Some(Some(1)),
    };
    assert_eq!(
        describe_adjustment(&both, Some(4)),
        " Before approving, the user adjusted the settings in the confirmation window: subagents are back on the session model; at most 1 subagent runs at once (the default is 4)."
    );
    let reset = Settings {
        subagent_model: None,
        max_concurrency: Some(None),
    };
    assert_eq!(
        describe_adjustment(&reset, None),
        " Before approving, the user adjusted the settings in the confirmation window: the limit on subagents at once is back to the default."
    );
    let set = Settings {
        subagent_model: Some(Some("p/m".to_owned())),
        max_concurrency: Some(Some(3)),
    };
    assert_eq!(
        describe_adjustment(&set, None),
        " Before approving, the user adjusted the settings in the confirmation window: subagents run on p/m (the main agent stays on the session model); at most 3 subagents run at once."
    );
}

/// The usual sentence is said for a setting the user did not change, and not for one they did.
#[test]
fn a_setting_that_was_not_changed_keeps_its_usual_sentence() {
    let only_bound = Settings {
        subagent_model: None,
        max_concurrency: Some(Some(2)),
    };
    assert_eq!(
        describe_run_settings(
            &only_bound,
            None,
            || "[limit]".to_owned(),
            || "[model]".to_owned(),
            || "[script]".to_owned()
        ),
        " Before approving, the user adjusted the settings in the confirmation window: at most 2 subagents run at once.[model][script]"
    );
    assert_eq!(
        describe_run_settings(
            &Settings::default(),
            None,
            || "[limit]".to_owned(),
            || "[model]".to_owned(),
            || "[script]".to_owned()
        ),
        "[limit][model][script]"
    );
}
