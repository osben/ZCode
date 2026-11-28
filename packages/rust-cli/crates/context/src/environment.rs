//! 环境段 attachment（`environment`：先决定何时发，再渲染整块或更新）。
//!
//! 压缩边界之后第一次、或平台 / shell / 系统版本变了时发整块；否则只在 cwd、git、附加目录变化时
//! 发 `# Environment update`。快照存在 attachment 的 `data.snapshot` 里，resume 后据此算增量。

use rust_cli_kernel_api::env::{EnvFacts, EnvPath};
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_prompts::texts::{self, render};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::desktop::{DesktopFacts, content};
use crate::render::{Bullet, attachments, bullets, escape};

pub(crate) const SOURCE: &str = "environment";

/// 环境快照（字段名与落库记录里的相同）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub working_directory: String,
    pub is_git_repo: bool,
    #[serde(default)]
    pub additional_working_directories: Vec<String>,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    /// Fork: the run is shown in ZCode Desktop (Node `desktopContext`); the full block carries the Desktop text. A
    /// snapshot without the key (an older build) counts as none.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub desktop_context: bool,
    /// Fork: the session's Gen UI output directory (Node `visualizationDirectory`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visualization_directory: Option<String>,
}

impl Snapshot {
    /// 附加目录来自会话配置，不来自执行环境（deployment.md §21）。
    pub(crate) fn from_facts(
        facts: &EnvFacts,
        additional: &[EnvPath],
        desktop: Option<&DesktopFacts>,
    ) -> Self {
        let present = |value: &str| (!value.is_empty()).then(|| value.to_owned());
        Self {
            working_directory: facts.cwd.as_str().to_owned(),
            is_git_repo: facts.is_git_repo,
            additional_working_directories: additional
                .iter()
                .map(|path| path.as_str().to_owned())
                .collect(),
            platform: facts.platform.clone(),
            shell: present(&facts.shell),
            os_version: present(&facts.os_version),
            desktop_context: desktop.is_some(),
            visualization_directory: desktop.and_then(|desktop| desktop.directory.clone()),
        }
    }

    /// The Desktop part of this snapshot (Node `desktopContextText`): none off the desktop, else the text in the form
    /// the directory decides. Updates compare these.
    fn desktop_text(&self) -> Option<String> {
        self.desktop_context
            .then(|| content(self.visualization_directory.is_some()))
    }

    /// 平台、shell、系统版本都没变；变了就要重发整块。
    fn same_host(&self, other: &Self) -> bool {
        self.platform == other.platform
            && self.shell == other.shell
            && self.os_version == other.os_version
    }
}

/// 整块。
fn whole(snapshot: &Snapshot) -> String {
    let value = |template: &str, value: &str| render(template, &[("value", value)]);
    let mut lines = vec![
        Bullet::Line(value(
            texts::environment_cwd(),
            &escape(&snapshot.working_directory),
        )),
        Bullet::Line(value(
            texts::environment_git(),
            &snapshot.is_git_repo.to_string(),
        )),
    ];
    if !snapshot.additional_working_directories.is_empty() {
        lines.push(Bullet::Line(texts::environment_additional().to_owned()));
        lines.push(Bullet::Nested(
            snapshot
                .additional_working_directories
                .iter()
                .map(|path| escape(path))
                .collect(),
        ));
    }
    if let Some(directory) = &snapshot.visualization_directory {
        lines.push(Bullet::Line(value(
            texts::environment_visualization(),
            &escape(directory),
        )));
    }
    lines.push(Bullet::Line(value(
        texts::environment_platform(),
        &escape(&snapshot.platform),
    )));
    if let Some(shell) = &snapshot.shell {
        lines.push(Bullet::Line(value(
            texts::environment_shell(),
            &escape(shell),
        )));
    }
    if let Some(os) = &snapshot.os_version {
        lines.push(Bullet::Line(value(texts::environment_os(), &escape(os))));
    }
    lines.push(Bullet::Line(texts::environment_untrusted().to_owned()));
    let block = render(texts::environment(), &[("lines", &bullets(lines))]);
    match snapshot.desktop_text() {
        Some(desktop) => format!("{block}\n\n{desktop}"),
        None => block,
    }
}

/// `# Environment update`（先算变化，再渲染）；没有变化时为 None。
fn update(latest: &Snapshot, current: &Snapshot) -> Option<(String, Vec<Value>)> {
    let mut lines = Vec::new();
    let mut changes = Vec::new();
    if latest.working_directory != current.working_directory {
        lines.push(Bullet::Line(render(
            texts::environment_cwd_was(),
            &[
                ("value", &escape(&current.working_directory)),
                ("from", &escape(&latest.working_directory)),
            ],
        )));
        changes.push(json!({"field": "workingDirectory", "from": latest.working_directory}));
    }
    if latest.is_git_repo != current.is_git_repo {
        lines.push(Bullet::Line(render(
            texts::environment_git_was(),
            &[
                ("value", &current.is_git_repo.to_string()),
                ("from", &latest.is_git_repo.to_string()),
            ],
        )));
        changes.push(json!({"field": "isGitRepo"}));
    }
    let before = &latest.additional_working_directories;
    let after = &current.additional_working_directories;
    let added: Vec<String> = after
        .iter()
        .filter(|path| !before.contains(path))
        .cloned()
        .collect();
    let removed: Vec<String> = before
        .iter()
        .filter(|path| !after.contains(path))
        .cloned()
        .collect();
    if !added.is_empty() || !removed.is_empty() {
        for (label, paths) in [
            (texts::environment_additional_added(), &added),
            (texts::environment_additional_removed(), &removed),
        ] {
            if !paths.is_empty() {
                lines.push(Bullet::Line(label.to_owned()));
                lines.push(Bullet::Nested(
                    paths.iter().map(|path| escape(path)).collect(),
                ));
            }
        }
        changes.push(json!({
            "field": "additionalWorkingDirectories", "added": added, "removed": removed
        }));
    }
    if latest.visualization_directory != current.visualization_directory {
        let value = current
            .visualization_directory
            .as_deref()
            .map_or_else(|| "none".to_owned(), escape);
        lines.push(Bullet::Line(match &latest.visualization_directory {
            Some(was) => render(
                texts::environment_visualization_was(),
                &[("value", &value), ("from", &escape(was))],
            ),
            None => render(texts::environment_visualization(), &[("value", &value)]),
        }));
        changes.push(json!({"field": "visualizationDirectory"}));
    }
    let mut parts = Vec::new();
    if !lines.is_empty() {
        parts.push(render(
            texts::environment_update(),
            &[("lines", &bullets(lines))],
        ));
    }
    // The Desktop part is compared by form: a changed form appends the whole text in the new form, or the sentence that
    // it no longer applies. With no bullet lines the update is that text alone, with no heading.
    let (before, after) = (latest.desktop_text(), current.desktop_text());
    if before != after {
        parts.push(after.unwrap_or_else(|| texts::desktop_no_longer().to_owned()));
        changes.push(json!({"field": "desktopContext"}));
    }
    if parts.is_empty() {
        return None;
    }
    Some((parts.join("\n\n"), changes))
}

fn snapshot_of(attachment: &AttachmentMessage) -> Option<Snapshot> {
    serde_json::from_value(attachment.data.get("snapshot")?.clone()).ok()
}

/// 这一步的环境 attachment：`(text, data)`，text 未包 `<system-reminder>`。
pub(crate) fn announce(
    history: &[Message],
    facts: &EnvFacts,
    additional: &[EnvPath],
    desktop: Option<&DesktopFacts>,
) -> Option<(String, Value)> {
    let current = Snapshot::from_facts(facts, additional, desktop);
    let announced: Vec<&AttachmentMessage> = attachments(history, SOURCE).collect();
    let latest = announced
        .last()
        .and_then(|attachment| snapshot_of(attachment));
    let has_whole = announced
        .iter()
        .any(|attachment| attachment.data.get("changes").is_none());
    let snapshot = json!(current);
    match latest {
        Some(latest) if has_whole && latest.same_host(&current) => {
            let (text, changes) = update(&latest, &current)?;
            Some((text, json!({"snapshot": snapshot, "changes": changes})))
        }
        _ => Some((whole(&current), json!({"snapshot": snapshot}))),
    }
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
