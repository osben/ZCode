//! The bundled skill pack (Node `bootstrap/src/app/bundled-skills.ts`, divergence 892): where the pack is found.
//!
//! Node searches the pack relative to the directory of its bundle entry (`zcode.cjs`) with the candidates below. The Host
//! gives the Rust agent that entry as the Node helper command (`ZCODE_FORK_NODE_HELPER_COMMAND`, `args[0]`), so the same
//! candidates are read from the same directory in the dev checkout, the E2E box and the packaged app.

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_files::{FileKind, PathStyle, StatFile};
use rust_cli_kernel_api::machine::Files;
use serde_json::Value;

/// The skill the pack carries (Node `DYNAMIC_WORKFLOW_SKILL_NAME`).
pub const DYNAMIC_WORKFLOW_SKILL: &str = "dynamic-workflows";

/// The pack's directory name (Node `BUNDLED_SKILL_PACK_DIRECTORY_NAME`).
const PACK_DIR: &str = "bundled-skills";
/// The directory in the pack that holds the skills (Node `BUNDLED_SKILL_PACK_SKILLS_DIRECTORY`).
const SKILLS_DIR: &str = "skills";
/// Every file of the skills package is required (Node `BUNDLED_SKILL_PACK_REQUIRED_PATHS`): a pack missing one is not used.
const REQUIRED_PATHS: [&str; 3] = [
    "skills/dynamic-workflows/SKILL.md",
    "skills/dynamic-workflows/patterns.md",
    "skills/dynamic-workflows/examples.md",
];

/// The directory of the Node bundle entry, from the Node helper command the Host gave the Rust agent (its JSON
/// `{command, args, env}`; `args[0]` is the entry, as in Node's `entrypointDir` = `dirname(argv[1])`). `None` when the
/// variable is absent or malformed: the Rust agent then has no pack, and says so once.
pub fn helper_entry_dir(raw: Option<&str>) -> Option<String> {
    let value: Value = serde_json::from_str(raw?.trim()).ok()?;
    let entry = value.get("args")?.as_array()?.first()?.as_str()?;
    if entry.trim().is_empty() {
        return None;
    }
    PathStyle::infer(entry).parent(entry)
}

/// The pack's `skills` directory, found as Node's `resolveFilesystemBundledSkillPackRoot` finds it: the candidates
/// `packages/bundled-skills`, `../bundled-skills`, `../../bundled-skills`, `../../../bundled-skills` relative to
/// `entry_dir`, the first one with a `skills` directory and every required file. `None` when no candidate has them.
/// Node's `process.cwd()` base is not searched (divergence 901).
pub async fn pack_skills_dir(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    entry_dir: &str,
) -> Option<String> {
    let style = PathStyle::infer(entry_dir);
    let mut packs = vec![style.join(entry_dir, &["packages", PACK_DIR])];
    let mut base = entry_dir.to_owned();
    for _ in 0..3 {
        base = style.parent(&base)?;
        packs.push(style.join(&base, &[PACK_DIR]));
    }
    for pack in packs {
        if is_complete_pack(files, workspace, style, &pack).await {
            return Some(style.join(&pack, &[SKILLS_DIR]));
        }
    }
    None
}

async fn is_complete_pack(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    style: PathStyle,
    pack: &str,
) -> bool {
    if kind_of(files, workspace, &style.join(pack, &[SKILLS_DIR])).await
        != Some(FileKind::Directory)
    {
        return false;
    }
    for required in REQUIRED_PATHS {
        let parts: Vec<&str> = required.split('/').collect();
        let path = style.join(pack, &parts);
        if kind_of(files, workspace, &path).await != Some(FileKind::File) {
            return false;
        }
    }
    true
}

async fn kind_of(files: &dyn Files, workspace: &WorkspaceRef, path: &str) -> Option<FileKind> {
    let request = StatFile {
        path: EnvPath::new(path),
    };
    files
        .stat(workspace, request)
        .await
        .ok()
        .flatten()
        .map(|stat| stat.kind)
}
