//! Node's own cases (packages/shared/test/sessionTitleSeed.test.ts, apps/zcode-cli/packages/cli/tests/
//! manual-skill-title-seed.test.ts).
use super::*;

fn skill_template(name: &str, tail: &str) -> String {
    [
        format!("Use the skill named `{name}` for this turn."),
        format!("First call the `Skill` tool with name `{name}` before doing the task."),
        "After the skill content is loaded, follow its instructions and continue.".to_owned(),
        String::new(),
        tail.to_owned(),
    ]
    .join("\n")
}

const NO_REQUEST: &str = "No additional user request was provided. Load the skill and respond according to its instructions.";

#[test]
fn a_composer_skill_mention_keeps_its_skill_label() {
    assert_eq!(
        seed("[$brainstorming](/home/u/.skills/brainstorming/SKILL.md) design a cache"),
        "$brainstorming design a cache"
    );
}

#[test]
fn the_manual_skill_prompt_becomes_its_task_or_the_skill_name() {
    assert_eq!(
        seed(&skill_template(
            "brainstorming",
            "User request:\ndesign a cache"
        )),
        "design a cache"
    );
    assert_eq!(
        seed(&skill_template("brainstorming", NO_REQUEST)),
        "$brainstorming"
    );
    let drifted = skill_template("x", "User request:\ndo it").replace("for this turn", "now");
    assert_eq!(seed(&drifted), drifted);
}

#[test]
fn plugin_and_session_mentions_drop_their_sigil() {
    assert_eq!(
        seed("[@Linear](plugin://linear@official) list my issues"),
        "Linear list my issues"
    );
    assert_eq!(
        seed("continue [#Cache work](#sess_abc.1) please"),
        "continue Cache work please"
    );
}

#[test]
fn file_and_directory_links_use_their_labels() {
    assert_eq!(
        seed("fix [a.ts](./src/a.ts) in [src/](./src/)"),
        "fix a.ts in src/"
    );
    assert_eq!(seed("see [\\[x\\].ts](<./a b/x.ts>)"), "see [x].ts");
    assert_eq!(seed("fix [a.ts](./src/a.ts) now"), "fix a.ts now");
}

#[test]
fn ordinary_links_and_pasted_code_stay() {
    for text in [
        "read [the docs](https://example.com/a) first",
        "call handlers[type](payload) here",
        "see [a](b)",
    ] {
        assert_eq!(seed(text), text);
    }
}

#[test]
fn windows_drive_and_file_destinations_are_mentions() {
    assert_eq!(seed("[$s](C:\\Users\\u\\SKILL.md) go"), "$s go");
    assert_eq!(seed("fix [a.ts](C:\\repo\\a.ts)"), "fix a.ts");
    assert_eq!(seed("fix [a.ts](file:///repo/a.ts)"), "fix a.ts");
}

#[test]
fn a_path_with_balanced_parentheses_is_one_link() {
    assert_eq!(seed("fix [a.ts](./My Dir (copy)/a.ts) now"), "fix a.ts now");
}

#[test]
fn hostile_and_long_inputs_stay_linear() {
    let hostile = format!("see [x]({}", "\\".repeat(5000));
    let started = std::time::Instant::now();
    assert_eq!(seed(&hostile), hostile);
    assert!(started.elapsed() < std::time::Duration::from_millis(500));
    let long = format!("[$s](/p/SKILL.md) {}", "x".repeat(100_000));
    assert!(seed(&long).starts_with("$s xxx"));
}

#[test]
fn bare_session_ids_are_removed() {
    // Callers collapse whitespace, so the removed token leaves a double space here.
    assert_eq!(seed("see #sess_abc123 now"), "see  now");
    assert_eq!(seed("see a#sess_abc"), "see a#sess_abc");
    assert_eq!(seed("#sess_abc123"), "#sess_abc123");
}

#[test]
fn commands_subagents_and_plain_skill_tokens_stay() {
    for text in [
        "/review src/a.ts",
        "@explorer find X",
        "$brainstorming plan",
        "/goal ship it",
    ] {
        assert_eq!(seed(text), text);
    }
}

#[test]
fn seeding_is_idempotent() {
    for text in [
        "[$s](/p/SKILL.md) task".to_owned(),
        skill_template("s", "User request:\nT"),
        "[@P](plugin://p@m) x #sess_a".to_owned(),
    ] {
        let once = seed(&text);
        assert_eq!(seed(&once), once);
    }
}
