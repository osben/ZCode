use super::*;
use crate::env::EnvPath;
use crate::ids::EnvironmentId;

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

#[test]
fn key_trims_only_a_trailing_separator_of_its_own_style() {
    assert_eq!(project_key("/work/repo"), "/work/repo");
    assert_eq!(project_key("/work/repo/"), "/work/repo");
    // POSIX: a backslash is a name character, so it is not a separator to trim.
    assert_eq!(project_key("/work/repo\\"), "/work/repo\\");
    // Windows paths trim both separators.
    assert_eq!(project_key("C:\\work\\repo\\"), "C:\\work\\repo");
    // A bare root keeps its separator.
    assert_eq!(project_key("/"), "/");
    assert_eq!(project_key("C:\\"), "C:\\");
    // Whitespace is part of the path (only an explicit identity is trimmed).
    assert_eq!(project_key("/work/repo "), "/work/repo ");
}

#[test]
fn sessions_record_and_lookup_their_workspace() {
    let sessions = SessionWorkspaces::default();
    let first = SessionId::new("s1");
    let second = SessionId::new("s2");
    sessions.record(&first, workspace("/work/a"));
    sessions.record(&second, workspace("/work/b"));
    assert_eq!(sessions.get(&first), Some(workspace("/work/a")));
    assert_eq!(sessions.get(&second), Some(workspace("/work/b")));
    assert_eq!(sessions.get(&SessionId::new("unknown")), None);
}
