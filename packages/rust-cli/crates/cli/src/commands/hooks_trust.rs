//! `zcode hooks trust`（docs/specs/rust-cli/config.md §4.3）：与 Node CLI 同形
//! （`apps/zcode-cli/packages/cli/src/hooks-trust-command.ts`、`bootstrap/src/workspace-hook-trust-cli.ts`），
//! 文本与错误逐字取 Node。信任记录与 Node CLI、App 共用。

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::machine::Files;
use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::{ConfigFile, TrustLoad, TrustRecord};
use serde_json::json;

use crate::config::trust::WorkspaceHooks;
use crate::config::{ConfigInputs, read_files};

pub(crate) const USAGE: &str = "Usage:
  zcode hooks trust status [--workspace <path-or-identity>] [--json]
  zcode hooks trust review [--workspace <path-or-identity>] [--json]
  zcode hooks trust grant --workspace <path-or-identity> --hook-digest <sha256> [--hook-digest <sha256> ...]
  zcode hooks trust grant --workspace <path-or-identity> --all-current --bundle-digest <sha256>
  zcode hooks trust revoke --workspace <path-or-identity> [--hook-digest <sha256> ... | --all]
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    Status,
    Review,
    Grant,
    Revoke,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Review => "review",
            Self::Grant => "grant",
            Self::Revoke => "revoke",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Options {
    workspace: Option<String>,
    digests: Vec<String>,
    all_current: bool,
    bundle: Option<String>,
    all: bool,
    pub(crate) json: bool,
}

/// 解析出的命令；`Help` 打印用法。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrustCommand {
    Help,
    Run(Action, Options),
}

/// `zcode hooks …`：不是 hooks 命令时为 None；错误是写到 stderr 的完整文本（Node `fail`）。
pub(crate) fn parse(args: &[String]) -> Option<Result<TrustCommand, String>> {
    if args.first().map(String::as_str) != Some("hooks") {
        return None;
    }
    let fail = |message: String| Err(format!("{message}\n{USAGE}"));
    if args.get(1).map(String::as_str) != Some("trust") {
        let name = args.get(1).map_or("", String::as_str);
        return Some(fail(format!("Unknown hooks command: {name}")));
    }
    let mut options = Options::default();
    let mut positionals = Vec::new();
    let mut help = false;
    let mut rest = args[2..].iter();
    while let Some(arg) = rest.next() {
        let mut value = |name: &str| {
            rest.next()
                .cloned()
                .ok_or_else(|| format!("Option '--{name} <value>' argument missing"))
        };
        let parsed = match arg.as_str() {
            "--workspace" => value("workspace").map(|v| options.workspace = Some(v)),
            "--hook-digest" => value("hook-digest").map(|v| options.digests.push(v)),
            "--bundle-digest" => value("bundle-digest").map(|v| options.bundle = Some(v)),
            "--all-current" => {
                options.all_current = true;
                Ok(())
            }
            "--all" => {
                options.all = true;
                Ok(())
            }
            "--json" => {
                options.json = true;
                Ok(())
            }
            "--help" | "-h" => {
                help = true;
                Ok(())
            }
            other if other.starts_with('-') => Err(format!("Unknown option '{other}'")),
            other => {
                positionals.push(other.to_owned());
                Ok(())
            }
        };
        if let Err(message) = parsed {
            return Some(fail(message));
        }
    }
    if help {
        return Some(Ok(TrustCommand::Help));
    }
    let action = match positionals.first().map_or("status", String::as_str) {
        "status" => Action::Status,
        "review" => Action::Review,
        "grant" => Action::Grant,
        "revoke" => Action::Revoke,
        other => return Some(fail(format!("Unknown hooks trust command: {other}"))),
    };
    if positionals.len() > 1 {
        return Some(fail(format!(
            "Unknown hooks trust command: {}",
            positionals[0]
        )));
    }
    Some(Ok(TrustCommand::Run(action, options)))
}

/// 运行需要的事实与端口。
pub(crate) struct TrustContext<'a> {
    pub(crate) files: &'a dyn Files,
    pub(crate) paths: &'a StoragePaths,
    pub(crate) cwd: &'a str,
    pub(crate) version: &'a str,
    pub(crate) now_ms: u64,
}

/// 命令的输出：退出码、stdout、stderr。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Output {
    pub(crate) code: u8,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// Node `path.resolve(cwd, value)`：规则是 kernel-api `env_path`（R1-9：以前自己判断绝对路径、自己拼接）。
fn join(base: &str, path: &str) -> String {
    PathStyle::infer(base).resolve(base, path, None)
}

/// Node `resolveTarget`：`local:` 等前缀是身份，其余是相对 cwd 的路径。
fn target(options: &Options, cwd: &str) -> (String, Option<String>) {
    let selected = options
        .workspace
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let identity = selected.filter(|value| {
        ["local:", "remote:", "ssh:", "container:", "wsl:"]
            .iter()
            .any(|prefix| value.starts_with(prefix))
    });
    match (identity, selected) {
        (Some(identity), _) => (cwd.to_owned(), Some(identity.to_owned())),
        (None, Some(path)) => (join(cwd, path), None),
        (None, None) => (cwd.to_owned(), None),
    }
}

async fn inspect_workspace(context: &TrustContext<'_>, options: &Options) -> WorkspaceHooks {
    let (path, identity) = target(options, context.cwd);
    inspect_at(context, path, identity).await
}

/// The project hooks of `path`, with records keyed by `identity` when given (a remote workspace's identity).
pub(crate) async fn inspect_at(
    context: &TrustContext<'_>,
    path: String,
    identity: Option<String>,
) -> WorkspaceHooks {
    inspect_read(context, path, identity).await.0
}

/// [`inspect_at`] and whether a config file could not be read or parsed.
async fn inspect_read(
    context: &TrustContext<'_>,
    path: String,
    identity: Option<String>,
) -> (WorkspaceHooks, bool) {
    let (hooks, unreadable, _) = inspect_review(context, path, identity).await;
    (hooks, unreadable)
}

/// A project file that declares hooks, in the order of the digest's `source_index`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HookSourceFile {
    pub(crate) path: String,
    /// `zcode.json` or `.zcode/config.json`.
    pub(crate) kind: &'static str,
    pub(crate) order: usize,
    pub(crate) editable: bool,
}

/// [`inspect_read`] with the project files that declare hooks (the App's hook review).
pub(crate) async fn inspect_review(
    context: &TrustContext<'_>,
    path: String,
    identity: Option<String>,
) -> (WorkspaceHooks, bool, Vec<HookSourceFile>) {
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(rust_cli_node_store::LOCAL_ENVIRONMENT),
        root: EnvPath::new(path.clone()),
    };
    let inputs = ConfigInputs {
        files: context.files,
        workspace: &workspace,
        paths: context.paths,
        process_env: &rust_cli_base::secret::EnvSnapshot::default(),
        flag: None,
        // `zcode hooks trust` 只看本机的项目。
        project_is_local: true,
    };
    let files = read_files(&inputs).await;
    // Node `discoverSnapshot` throws on a config it cannot read or parse.
    let unreadable = matches!(files.user, ConfigFile::Invalid { .. })
        || files
            .projects
            .iter()
            .any(|project| matches!(project.file, ConfigFile::Invalid { .. }));
    let mut warnings = Vec::new();
    let mut hooks = WorkspaceHooks::inspect(
        &path,
        files.user.object(),
        &files.projects,
        context.paths,
        &mut warnings,
    )
    .await;
    if let Some(identity) = identity {
        hooks.identity = identity;
    }
    // The same files `candidates` keeps: every project file with a `hooks` key.
    let sources = files
        .projects
        .iter()
        .filter(|file| {
            file.file
                .object()
                .is_some_and(|object| object.contains_key("hooks"))
        })
        .map(|file| HookSourceFile {
            path: file.path.clone(),
            kind: file.kind.as_str(),
            order: file.order,
            editable: file.editable,
        })
        .collect();
    (hooks, unreadable, sources)
}

#[path = "hooks_trust_status.rs"]
mod status;

pub(crate) use status::run;

#[cfg(test)]
#[path = "hooks_trust_tests.rs"]
mod tests;

/// grant 的记录（Node `grantWorkspaceHookTrust` 的对象字面量）。
pub(crate) fn records(
    hooks: &WorkspaceHooks,
    selected: &[usize],
    context: &TrustContext<'_>,
) -> Vec<TrustRecord> {
    let bundle = hooks
        .bundle
        .as_ref()
        .map(|bundle| bundle.bundle_digest.clone());
    selected
        .iter()
        .filter_map(|index| hooks.entries().get(*index))
        .map(|entry| TrustRecord {
            workspace_identity: hooks.identity.clone(),
            hook_declaration_digest: entry.digest.clone(),
            granted_at: rust_cli_base::js::iso_timestamp(context.now_ms),
            last_used_at: None,
            bundle_digest_at_grant: bundle.clone(),
            event_at_grant: entry.event.as_str().to_owned(),
            display_command_at_grant: entry.hook.display(),
            source_path_at_grant: entry.source_relative_path.clone(),
            source_discovery_order_at_grant: Some(entry.source_discovery_order as u64),
            matcher_at_grant: Some(entry.matcher.clone()),
            matcher_index_at_grant: Some(entry.matcher_index as u64),
            hook_index_at_grant: Some(entry.hook_index as u64),
            app_version_at_grant: Some(context.version.to_owned()),
        })
        .collect()
}

/// `{accepted: false, reasonCode}` 或 `Error: …`。
fn failure(options: &Options, reason: &str) -> Output {
    if options.json {
        let body = serde_json::to_string_pretty(&json!({"accepted": false, "reasonCode": reason}))
            .unwrap_or_default();
        Output {
            code: 1,
            stdout: format!("{body}\n"),
            stderr: String::new(),
        }
    } else {
        Output {
            code: 1,
            stdout: String::new(),
            stderr: format!("Error: {reason}\n"),
        }
    }
}

fn unique(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if !out.contains(value) {
            out.push(value.clone());
        }
    }
    out
}

/// The reason codes `workspace/hooks/trustGrant` may answer (`zcodeWorkspaceHookTrustGrantReasonCodeSchema`).
const APP_REASONS: [&str; 6] = [
    "workspace_hooks_blocked_by_policy",
    "workspace_hooks_bundle_changed",
    "workspace_hooks_snapshot_mismatch",
    "workspace_hooks_policy_requires_pretrust",
    "workspace_hooks_trust_store_corrupt",
    "workspace_hooks_config_unreadable",
];

/// Node `toPublicReasonCode`: anything else (an error text with paths, a status reason) becomes the stable
/// `workspace_hooks_config_unreadable`, so no local detail crosses the protocol.
fn public_reason(reason: &str) -> &'static str {
    APP_REASONS
        .iter()
        .find(|code| **code == reason)
        .copied()
        .unwrap_or("workspace_hooks_config_unreadable")
}

/// `workspace/hooks/trustGrant` (Node `grantWorkspaceHookTrustForProtocol` with no workspace policy, i.e.
/// `user_decides`): grants exactly the declaration the Settings page showed, after rediscovering the bundle, and
/// accepts only when a re-read shows it trusted.
pub(crate) async fn grant_for_app(
    context: &TrustContext<'_>,
    (path, identity): (String, Option<String>),
    bundle_digest: &str,
    declaration_digest: &str,
) -> serde_json::Value {
    let options = Options {
        digests: vec![declaration_digest.to_owned()],
        bundle: Some(bundle_digest.to_owned()),
        ..Options::default()
    };
    let (hooks, unreadable) = inspect_read(context, path.clone(), identity.clone()).await;
    if unreadable {
        return json!({"accepted": false, "reasonCode": "workspace_hooks_config_unreadable"});
    }
    let granted = match hooks.bundle {
        None => Err("no declarations".to_owned()),
        Some(_) => match status::select(&hooks, &options) {
            Ok(selected) => hooks
                .store
                .grant(records(&hooks, &selected, context))
                .await
                .map_err(|error| error.to_string()),
            Err(reason) => Err(reason.to_owned()),
        },
    };
    if let Err(reason) = granted {
        return json!({"accepted": false, "reasonCode": public_reason(&reason)});
    }
    confirm_grant(context, (path, identity), declaration_digest).await
}

/// Node `didGrantExactDeclaration` over the status re-read after a grant: accepted only while the declaration is
/// still in the workspace's bundle and trusted. A corrupt store answers its own reason; a config that cannot be read
/// and any other status answer `workspace_hooks_config_unreadable` (`toPublicReasonCode`).
pub(crate) async fn confirm_grant(
    context: &TrustContext<'_>,
    (path, identity): (String, Option<String>),
    declaration_digest: &str,
) -> serde_json::Value {
    let (after, unreadable) = inspect_read(context, path, identity).await;
    let reason = if unreadable {
        public_reason("")
    } else if corrupt(&after) {
        "workspace_hooks_trust_store_corrupt"
    } else if after
        .entries()
        .iter()
        .any(|entry| entry.digest == declaration_digest)
        && after.trusted().contains(declaration_digest)
    {
        return json!({"accepted": true});
    } else {
        public_reason("")
    };
    json!({"accepted": false, "reasonCode": reason})
}

fn corrupt(hooks: &WorkspaceHooks) -> bool {
    matches!(hooks.load, TrustLoad::Corrupt)
}
