use super::{ParsedRemoteIdentity, RemoteIdentityKind, is_remote_workspace_identity, parse_remote_workspace_identity};

/// Expected values printed by Node's `parseRemoteWorkspaceIdentity` (packages/shared/src/remote-workspace-identity.ts).
#[test]
fn parsing_matches_node() {
    let parsed = |kind, path: &str, server: Option<&str>| {
        Some(ParsedRemoteIdentity {
            kind,
            workspace_path: path.to_owned(),
            source_server_id: server.map(str::to_owned),
        })
    };
    let cases = [
        ("remote:ssh:host:22:user:/a/b", parsed(RemoteIdentityKind::Ssh, "/a/b", None)),
        ("remote:ssh:host:22:us:er:/a", parsed(RemoteIdentityKind::Ssh, "/a", None)),
        ("remote:ssh:host:22:user:rel", None),
        ("remote:ssh::22:user:/a", None),
        ("remote:wsl:Ubuntu:/home/x", parsed(RemoteIdentityKind::Wsl, "/home/x", None)),
        ("remote:wsl:Ubuntu:dev:/home/x", parsed(RemoteIdentityKind::Wsl, "/home/x", None)),
        ("remote:wsl:Ubuntu:dev", None),
        ("remote:docker:c1:/app", parsed(RemoteIdentityKind::Docker, "/app", None)),
        ("remote:server:srv-1:/w", parsed(RemoteIdentityKind::Server, "/w", Some("srv-1"))),
        ("remote:server::/w", None),
        ("remote:other", None),
        ("remote:", None),
        ("remote:ftp:x:/a", None),
        ("local:/a", None),
        ("/Users/dev/a", None),
        (" remote:docker:c:/a", None),
        ("remote:docker:c:/", parsed(RemoteIdentityKind::Docker, "/", None)),
        ("remote:ssh:h:22:u:/", parsed(RemoteIdentityKind::Ssh, "/", None)),
    ];
    for (identity, expected) in cases {
        assert_eq!(parse_remote_workspace_identity(identity), expected, "{identity}");
        assert_eq!(is_remote_workspace_identity(identity), expected.is_some(), "{identity}");
    }
}
