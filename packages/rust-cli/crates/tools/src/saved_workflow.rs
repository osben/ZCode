//! Fork: saved workflows, the project and global definitions that SaveWorkflow writes and ListSavedWorkflows reads
//! (Node `contracts/src/tools/saved-workflow.ts` and `core/src/tool/handlers/saved-workflows/store.ts`; specs/fork-rust-workflow-engine.md,
//! W7-8b). The store is local to the agent process, as in Node: a project root under the session's working directory and
//! a global root under the home directory. Reads and writes are synchronous and small.

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};

use rust_cli_fs::{is_regular_file as file_exists, list_file_names, read_text, write_text};

use serde_json::Value;
#[cfg(test)]
use serde_json::json;

#[path = "saved_workflow_frontmatter.rs"]
mod frontmatter;

pub use frontmatter::{ParseError, SENTINEL, parse, serialize, starts_with_sentinel};

/// Saved-definition file extension. `.dwf.ts` keeps the file valid TypeScript (the metadata is a block comment).
pub const FILE_EXTENSION: &str = ".dwf.ts";
/// The project directory, relative to the session working directory.
pub const PROJECT_DIR: &str = ".zcode/workflows";
/// The global directory, relative to the home directory.
pub const GLOBAL_DIR: &str = ".zcode/workflows";
/// Longest usable name (a file name on every platform, and descriptive).
pub const MAX_NAME_CHARS: usize = 64;

/// Whether a name can identify a saved workflow. The character rule is the path-traversal defense: names are file names.
pub fn is_valid_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return false;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return false;
    }
    // `.` and `..` match the character rule but name directory entries.
    if !name.chars().any(|c| c != '.') {
        return false;
    }
    // Windows reserves these device names with or without an extension (`con.dwf.ts` is the `CON` device there).
    // Divergence 118: Node accepts them.
    let stem = name.split('.').next().unwrap_or(name);
    !WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// The Windows device names a file stem may not be (case-insensitive).
const WINDOWS_RESERVED_STEMS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Where a definition lives. A file's scope comes from its directory and is not stored in its metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Project,
    Global,
}

impl Scope {
    /// The wire literal.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
        }
    }

    /// Parses the wire literal; anything else is not a scope.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "project" => Some(Self::Project),
            "global" => Some(Self::Global),
            _ => None,
        }
    }
}

/// A same-named definition in the other scope, as the confirmation shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shadowing {
    /// Saving a project copy shadows a global copy in this project.
    HidesGlobal,
    /// Saving a global copy is shadowed by a project copy in this project.
    HiddenByProject,
}

/// The type of one declared argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArgType {
    String,
    Number,
    Boolean,
    /// Accepts any JSON value; the declaration says so instead of leaving it unchecked.
    Json,
}

/// One declared argument (Node `SavedWorkflowArgDeclaration`). `default` is `Some(Null)` when the file says `default: null`.
#[derive(Debug, Clone, PartialEq)]
pub struct ArgDecl {
    pub ty: ArgType,
    pub description: Option<String>,
    pub required: Option<bool>,
    pub default: Option<Value>,
}

/// The metadata block of a saved definition (Node `SavedWorkflowMeta`). Arguments keep their declared order.
#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub description: String,
    pub when_to_use: Option<String>,
    pub args: Option<Vec<(String, ArgDecl)>>,
}

/// One saved definition as the list shows it: metadata and location, never the script.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedEntry {
    pub name: String,
    pub description: String,
    pub when_to_use: Option<String>,
    pub args: Option<Vec<(String, ArgDecl)>>,
    pub scope: Scope,
    pub path: String,
}

/// A file in a root that cannot be listed (a hand-edited block, a bad name, an unreadable entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidEntry {
    pub path: String,
    pub reason: String,
}

/// The catalog: usable definitions (a shadowed copy is left out) and the files that could not be read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Listing {
    pub entries: Vec<SavedEntry>,
    pub invalid: Vec<InvalidEntry>,
}

/// Why a save did not happen.
#[derive(Debug)]
pub enum SaveError {
    /// The name is not one the rules allow (it would not be a file name inside the root).
    InvalidName(String),
    /// The file could not be written.
    Io(io::Error),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(name) => write!(formatter, "'{name}' is not a usable workflow name"),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

/// The outcome of a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub path: PathBuf,
    pub scope: Scope,
    /// Whether this write replaced a file that existed.
    pub overwritten: bool,
}

/// The two roots of one session: the project root under its working directory, and the global root under the home.
#[derive(Debug, Clone)]
pub struct Store {
    project: PathBuf,
    global: PathBuf,
}

impl Store {
    pub fn new(cwd: &Path, home: &Path) -> Self {
        Self {
            project: cwd.join(PROJECT_DIR),
            global: home.join(GLOBAL_DIR),
        }
    }

    fn root(&self, scope: Scope) -> &Path {
        match scope {
            Scope::Project => &self.project,
            Scope::Global => &self.global,
        }
    }

    /// The file a name lives in under a scope.
    pub fn path(&self, scope: Scope, name: &str) -> PathBuf {
        self.root(scope).join(format!("{name}{FILE_EXTENSION}"))
    }

    /// Whether the name has a file under the scope.
    pub fn exists(&self, name: &str, scope: Scope) -> bool {
        is_valid_name(name) && file_exists(&self.path(scope, name))
    }

    /// The same-named file in the other scope, if any. Callers check the name first.
    pub fn shadowing(&self, name: &str, scope: Scope) -> Option<Shadowing> {
        if !is_valid_name(name) {
            return None;
        }
        let other = match scope {
            Scope::Project => Scope::Global,
            Scope::Global => Scope::Project,
        };
        if !file_exists(&self.path(other, name)) {
            return None;
        }
        Some(match scope {
            Scope::Project => Shadowing::HidesGlobal,
            Scope::Global => Shadowing::HiddenByProject,
        })
    }

    /// The catalog: the project root first, then the global root. A name claimed by the project is not listed from the
    /// global root, because the project copy is the one that runs.
    pub fn list(&self) -> Listing {
        let mut listing = Listing::default();
        let mut claimed: BTreeSet<String> = BTreeSet::new();
        for scope in [Scope::Project, Scope::Global] {
            let root = self.root(scope);
            let names = match list_file_names(root) {
                Ok(names) => names,
                Err(error) if is_absent(&error) => continue,
                Err(error) => {
                    listing.invalid.push(InvalidEntry {
                        path: root.display().to_string(),
                        reason: error.to_string(),
                    });
                    continue;
                }
            };
            for file_name in order_entries(names) {
                let Some(name) = file_name.strip_suffix(FILE_EXTENSION) else {
                    continue;
                };
                let path = root.join(&file_name);
                let path_text = path.display().to_string();
                if !is_valid_name(name) {
                    listing.invalid.push(InvalidEntry {
                        path: path_text,
                        reason: "file name is not a usable workflow name".to_owned(),
                    });
                    continue;
                }
                if claimed.contains(name) {
                    continue;
                }
                let source = match read_text(&path) {
                    Ok(source) => source,
                    Err(error) => {
                        listing.invalid.push(InvalidEntry {
                            path: path_text,
                            reason: error.to_string(),
                        });
                        continue;
                    }
                };
                match parse(&source) {
                    Ok(parsed) => {
                        claimed.insert(name.to_owned());
                        listing.entries.push(SavedEntry {
                            name: name.to_owned(),
                            description: parsed.meta.description,
                            when_to_use: parsed.meta.when_to_use,
                            args: parsed.meta.args,
                            scope,
                            path: path_text,
                        });
                    }
                    Err(error) => listing.invalid.push(InvalidEntry {
                        path: path_text,
                        reason: parse_failure(&error),
                    }),
                }
            }
        }
        listing
    }

    /// Writes the definition: the metadata block, then the script byte for byte. A name the rules do not allow is
    /// refused before anything is written.
    pub fn save(
        &self,
        name: &str,
        meta: &Meta,
        script: &str,
        scope: Scope,
    ) -> Result<Saved, SaveError> {
        if !is_valid_name(name) {
            return Err(SaveError::InvalidName(name.to_owned()));
        }
        let path = self.path(scope, name);
        let overwritten = file_exists(&path);
        write_text(&path, &serialize(meta, script)).map_err(SaveError::Io)?;
        Ok(Saved {
            path,
            scope,
            overwritten,
        })
    }
}

/// The order the list reads files in: Node sorts the file names with their suffix (`sort()` on the names), so the
/// catalog is the same on every machine whatever order the directory returns them in.
pub fn order_entries(mut names: Vec<String>) -> Vec<String> {
    names.sort();
    names
}

/// The reason a file is listed as invalid: the parse failure's reason and detail.
fn parse_failure(error: &ParseError) -> String {
    format!("{}: {}", error.reason(), error.detail())
}

/// A missing directory (or a path component that is a file) is absent, not an error.
fn is_absent(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

#[cfg(test)]
#[path = "saved_workflow_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "saved_workflow_frontmatter_tests.rs"]
mod frontmatter_tests;
