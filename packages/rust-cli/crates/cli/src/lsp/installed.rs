//! Fork: whether a language server's command can be found (specs/fork-rust-lsp.md "Install probe"), Node adapters
//! `lsp/command-resolution.ts` `isLspCommandInstalled`. Nothing is spawned and nothing is cached.

use std::path::{Path, PathBuf};

/// Node `DEFAULT_WINDOWS_PATHEXT`.
const DEFAULT_PATHEXT: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// Node `getWindowsEnvValue`: the first key equal to `name` ignoring case (Node uses it for `PATH` on every platform).
fn lookup<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// Node `extname(file) !== ""`: the last segment has a dot that is not its first character.
fn has_extension(file: &str) -> bool {
    let name = file.rsplit(['/', '\\']).next().unwrap_or(file);
    name.rfind('.').is_some_and(|at| at > 0)
}

/// Node `lookupCandidates`.
pub(super) fn candidates(command: &str, env: &[(String, String)], windows: bool) -> Vec<PathBuf> {
    let has_directory =
        command.contains('/') || command.contains('\\') || Path::new(command).is_absolute();
    if windows {
        let extensions: Vec<String> = lookup(env, "PATHEXT")
            .map(|raw| {
                raw.split(';')
                    .map(str::trim)
                    .filter(|extension| !extension.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| DEFAULT_PATHEXT.iter().map(|&ext| ext.to_owned()).collect());
        let with_extensions = |file: &str| -> Vec<String> {
            if has_extension(file) {
                return vec![file.to_owned()];
            }
            std::iter::once(file.to_owned())
                .chain(
                    extensions
                        .iter()
                        .map(|extension| format!("{file}{}", extension.to_lowercase())),
                )
                .collect()
        };
        if has_directory {
            // A relative path resolves against the process cwd, as Node's `win32.resolve(cwd, file)`.
            return with_extensions(command)
                .into_iter()
                .map(PathBuf::from)
                .collect();
        }
        let names = with_extensions(command);
        return lookup(env, "PATH")
            .unwrap_or_default()
            .split(';')
            .map(|entry| entry.strip_prefix('"').unwrap_or(entry))
            .map(|entry| entry.strip_suffix('"').unwrap_or(entry))
            .filter(|entry| !entry.is_empty())
            .flat_map(|dir| names.iter().map(move |name| Path::new(dir).join(name)))
            .collect();
    }
    if has_directory {
        // Relative to the agent process's cwd (Node `resolve(process.cwd(), command)`), not the workspace.
        return vec![PathBuf::from(command)];
    }
    lookup(env, "PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(command))
        .collect()
}

/// Node `isLspCommandInstalled`: the first candidate that is a regular file this process may execute.
pub(super) async fn installed(command: &str, env: &[(String, String)]) -> bool {
    for candidate in candidates(command, env, cfg!(windows)) {
        if rust_cli_fs::is_executable_file(&candidate).await {
            return true;
        }
    }
    false
}
