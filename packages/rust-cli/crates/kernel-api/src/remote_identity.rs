//! Fork: the remote workspace identity parser, a port of Node's `parseRemoteWorkspaceIdentity`
//! (packages/shared/src/remote-workspace-identity.ts). Business code asks this module instead of splitting the format:
//!
//! - `remote:ssh:<host>:<port>:<username>:<posixPath>`
//! - `remote:wsl:<distro>[:<user>]:<posixPath>`
//! - `remote:docker:<container>:<posixPath>`
//! - `remote:server:<serverId>:<posixPath>`

const PREFIX: &str = "remote:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteIdentityKind {
    Ssh,
    Wsl,
    Docker,
    Server,
}

impl RemoteIdentityKind {
    fn parse(text: &str) -> Option<Self> {
        match text {
            "ssh" => Some(Self::Ssh),
            "wsl" => Some(Self::Wsl),
            "docker" => Some(Self::Docker),
            "server" => Some(Self::Server),
            _ => None,
        }
    }

    /// Node `AUTHORITY_SEGMENTS`: ssh has host, port and username; the others one segment.
    fn authority_segments(self) -> usize {
        match self {
            Self::Ssh => 3,
            Self::Wsl | Self::Docker | Self::Server => 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemoteIdentity {
    pub kind: RemoteIdentityKind,
    /// The path on the remote machine (POSIX form, starts with `/`).
    pub workspace_path: String,
    /// The Source Server id of a `server` identity.
    pub source_server_id: Option<String>,
}

/// Node `parseRemoteWorkspaceIdentity`: None for a local or malformed identity.
pub fn parse_remote_workspace_identity(identity: &str) -> Option<ParsedRemoteIdentity> {
    let rest = identity.strip_prefix(PREFIX)?;
    let kind_end = rest.find(':').filter(|end| *end > 0)?;
    let kind = RemoteIdentityKind::parse(&rest[..kind_end])?;
    let mut cursor = kind_end + 1;
    let mut source_server_id = None;
    for segment in 0..kind.authority_segments() {
        // An SSH username may contain colons: its segment ends at the `:/` before the absolute path.
        let separator = if kind == RemoteIdentityKind::Ssh && segment == 2 {
            ":/"
        } else {
            ":"
        };
        let next = rest.get(cursor..)?.find(separator).map(|at| cursor + at)?;
        if next <= cursor {
            return None;
        }
        if kind == RemoteIdentityKind::Server && segment == 0 {
            source_server_id = Some(rest[cursor..next].to_owned());
        }
        cursor = next + 1;
    }
    // The optional WSL user: a path always starts with `/`, so anything else is the user segment.
    if kind == RemoteIdentityKind::Wsl && !rest[cursor..].starts_with('/') {
        let user_end = rest[cursor..].find(':').map(|at| cursor + at)?;
        if user_end <= cursor {
            return None;
        }
        cursor = user_end + 1;
    }
    let workspace_path = &rest[cursor..];
    workspace_path.starts_with('/').then(|| ParsedRemoteIdentity {
        kind,
        workspace_path: workspace_path.to_owned(),
        source_server_id,
    })
}

/// Node `isRemoteWorkspaceIdentity`.
pub fn is_remote_workspace_identity(identity: &str) -> bool {
    parse_remote_workspace_identity(identity).is_some()
}

#[cfg(test)]
#[path = "remote_identity_tests.rs"]
mod tests;
