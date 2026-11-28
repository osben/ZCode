//! The ZCode Desktop Context in the environment announcement (specs/fork-rust-desktop-context-announcement.md): Node 3.18
//! `buildEnvironmentAnnouncement` and `desktopContextText`. The Desktop text itself is pinned in `desktop_tests.rs`.

use rust_cli_kernel_api::env::{EnvFacts, EnvPath};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use serde_json::{Value, json};

use crate::desktop::{DesktopFacts, content};
use crate::environment::{SOURCE, announce};

const DIR: &str = "/root/visualizations/abc";
const NO_LONGER: &str = "The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.";

fn facts(cwd: &str) -> EnvFacts {
    EnvFacts {
        cwd: EnvPath::new(cwd),
        platform: "darwin".to_owned(),
        os_version: "Darwin 24.6.0".to_owned(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        home: None,
        uid: None,
    }
}

fn desktop(directory: Option<&str>) -> DesktopFacts {
    DesktopFacts {
        directory: directory.map(str::to_owned),
    }
}

fn run(history: &[Message], cwd: &str, desktop: Option<&DesktopFacts>) -> Option<(String, Value)> {
    announce(history, &facts(cwd), &[], desktop)
}

fn announced((text, data): (String, Value)) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new("a"),
        source: SOURCE.to_owned(),
        text,
        data,
    })
}

/// The block sent before: on the desktop with a directory, without one, or off the desktop.
fn before(form: Option<Option<&str>>) -> Vec<Message> {
    let facts = form.map(desktop);
    vec![announced(run(&[], "/w", facts.as_ref()).unwrap())]
}

#[test]
fn the_full_block_names_the_directory_before_platform_and_ends_with_the_desktop_text() {
    let (text, data) = run(&[], "/w", Some(&desktop(Some(DIR)))).unwrap();
    assert!(text.contains(&format!(
        " - Is a git repository: false\n - Visualization directory for this session: {DIR}\n - Platform: darwin\n"
    )));
    assert!(text.ends_with(&format!("\n\n{}", content(true))), "{text}");
    assert_eq!(data["snapshot"]["desktopContext"], true);
    assert_eq!(data["snapshot"]["visualizationDirectory"], DIR);
    assert!(data.get("changes").is_none());
}

#[test]
fn without_a_directory_there_is_no_bullet_and_no_interactive_views() {
    let (text, data) = run(&[], "/w", Some(&desktop(None))).unwrap();
    assert!(!text.contains("Visualization directory"));
    assert!(text.ends_with(&content(false)), "{text}");
    assert!(!text.contains("### Interactive views"));
    assert_eq!(data["snapshot"]["desktopContext"], true);
    assert!(data["snapshot"].get("visualizationDirectory").is_none());
}

#[test]
fn off_the_desktop_the_block_has_neither_and_the_snapshot_has_no_keys() {
    let (text, data) = run(&[], "/w", None).unwrap();
    assert!(!text.contains("ZCode Desktop Context"));
    assert!(data["snapshot"].get("desktopContext").is_none());
    assert!(data["snapshot"].get("visualizationDirectory").is_none());
}

#[test]
fn an_unchanged_form_and_directory_add_nothing() {
    let history = before(Some(Some(DIR)));
    assert!(run(&history, "/w", Some(&desktop(Some(DIR)))).is_none());
    let history = before(Some(None));
    assert!(run(&history, "/w", Some(&desktop(None))).is_none());
    assert!(run(&before(None), "/w", None).is_none());
}

#[test]
fn a_snapshot_written_before_the_keys_existed_counts_as_none() {
    let old = announced((
        "# Environment\nold".to_owned(),
        json!({"snapshot": {
            "workingDirectory": "/w", "isGitRepo": false,
            "platform": "darwin", "shell": "zsh", "osVersion": "Darwin 24.6.0"
        }}),
    ));
    let (text, _) = run(&[old], "/w", Some(&desktop(None))).unwrap();
    assert_eq!(text, content(false));
}

#[test]
fn entering_the_desktop_appends_the_text_after_the_directory_line() {
    let (text, data) = run(&before(None), "/w", Some(&desktop(Some(DIR)))).unwrap();
    assert_eq!(
        text,
        format!(
            "# Environment update\n - Visualization directory for this session: {DIR}\n\n{}",
            content(true)
        )
    );
    let fields: Vec<&Value> = data["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|change| &change["field"])
        .collect();
    assert_eq!(fields, ["visualizationDirectory", "desktopContext"]);
}

/// Only the Desktop part changed: the update is its text alone, without the `# Environment update` heading.
#[test]
fn a_desktop_only_change_is_the_text_alone() {
    let (text, data) = run(&before(None), "/w", Some(&desktop(None))).unwrap();
    assert_eq!(text, content(false));
    assert_eq!(data["changes"][0]["field"], "desktopContext");
    // The form changed from "without a directory" to "with one": the directory line comes with the text.
    let (text, _) = run(&before(Some(None)), "/w", Some(&desktop(Some(DIR)))).unwrap();
    assert!(
        text.starts_with(
            "# Environment update\n - Visualization directory for this session: /root"
        )
    );
    assert!(text.ends_with(&content(true)));
}

#[test]
fn leaving_the_desktop_says_the_text_no_longer_applies() {
    let (text, _) = run(&before(Some(Some(DIR))), "/w", None).unwrap();
    assert_eq!(
        text,
        format!(
            "# Environment update\n - Visualization directory for this session: none (was {DIR})\n\n{NO_LONGER}"
        )
    );
    let (text, _) = run(&before(Some(None)), "/w", None).unwrap();
    assert_eq!(text, NO_LONGER);
}

/// A fork that only changes the directory keeps the form: one directory line, no text.
#[test]
fn a_directory_change_alone_is_one_line() {
    let (text, data) = run(
        &before(Some(Some(DIR))),
        "/w",
        Some(&desktop(Some("/root/visualizations/def"))),
    )
    .unwrap();
    assert_eq!(
        text,
        format!(
            "# Environment update\n - Visualization directory for this session: /root/visualizations/def (was {DIR})"
        )
    );
    assert_eq!(data["changes"][0]["field"], "visualizationDirectory");
}

#[test]
fn bullet_lines_come_first_and_the_text_follows_after_a_blank_line() {
    let (text, _) = run(&before(None), "/v", Some(&desktop(None))).unwrap();
    assert_eq!(
        text,
        format!(
            "# Environment update\n - Primary working directory: /v (was /w)\n\n{}",
            content(false)
        )
    );
}
