//! Workspace MCP trust against Node's golden output (`scripts/fork-rust-agent/mcp-trust-golden.mts`).
#![allow(
    clippy::disallowed_methods,
    reason = "the test writes a Node-written store to a temporary directory"
)]
use rust_cli_platform::local::McpTrustStore;

use super::super::files::project_file;
use super::*;

const GOLDEN: &str = include_str!("../../tests/fixtures/mcp-trust-golden.json");
const FALLBACK_KEY: &str = ".agents/mcp.json";
/// Node's discovery order at one level.
const ORDER: [&str; 2] = ["zcode.json", ".zcode/config.json"];

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

fn raw(value: &Value) -> Vec<u8> {
    match value {
        Value::String(text) => text.as_bytes().to_vec(),
        other => serde_json::to_vec(other).unwrap(),
    }
}

struct Case {
    target: Target,
    user: Option<Map<String, Value>>,
    projects: Vec<ProjectFile>,
    fallback: Fallback,
    reviews: Value,
}

fn case(value: &Value) -> Case {
    let workspace = value["workspace"].as_str().unwrap();
    let files = value["files"].as_object().unwrap();
    let mut projects = Vec::new();
    for relative in ORDER {
        if let Some(content) = files.get(relative) {
            let path = format!("{workspace}/{relative}");
            let file = ConfigFile::parse(&raw(content));
            projects.push(project_file(workspace, path, projects.len(), file));
        }
    }
    let fallback = files
        .get(FALLBACK_KEY)
        .map_or(Fallback::Missing, |content| Fallback::parse(&raw(content)));
    Case {
        target: Target::new(workspace, value["identity"].as_str()),
        user: value["user"].as_object().cloned(),
        projects,
        fallback,
        reviews: value["reviews"].clone(),
    }
}

fn run(case: &Case, store: &McpTrustLoad) -> (Result<Discovery, Unreadable>, Vec<Review>) {
    let inputs = Inputs {
        user: case.user.as_ref(),
        projects: &case.projects,
        fallback: &case.fallback,
    };
    let discovery = discover(&case.target, &inputs);
    let reviews = reviews(&case.target, discovery.as_ref().map_err(|e| *e), store).unwrap();
    (discovery, reviews)
}

#[test]
fn reviews_match_the_node_golden() {
    let golden = golden();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 7);
    for value in cases {
        let name = value["name"].as_str().unwrap();
        let case = case(value);
        let (_, reviews) = run(&case, &McpTrustLoad::Missing);
        assert_eq!(reviews_value(&reviews), case.reviews, "{name}");
        let order: Vec<&String> = case.reviews.as_object().unwrap().keys().collect();
        let ours: Vec<&String> = reviews.iter().map(|review| &review.name).collect();
        assert_eq!(ours, order, "{name}: review order");
    }
}

#[test]
fn unreadable_and_invalid_projects_follow_node() {
    let golden = golden();
    let by_name = |name: &str| {
        let value = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["name"] == name)
            .unwrap();
        case(value)
    };
    let (discovery, _) = run(&by_name("unreadable"), &McpTrustLoad::Missing);
    assert_eq!(discovery, Err(Unreadable));
    let (discovery, _) = run(&by_name("invalid-blocks-fallback"), &McpTrustLoad::Missing);
    let discovery = discovery.unwrap();
    assert!(discovery.declarations.is_empty());
    // The invalid project server blocks the fallback; its name is not required (only valid project names are).
    assert!(!discovery.required.contains("fb"));
    let (discovery, _) = run(&by_name("fallback"), &McpTrustLoad::Missing);
    // A broken fallback entry is still claimed by the workspace.
    assert!(discovery.unwrap().required.contains("broken"));
}

#[tokio::test]
async fn a_node_written_grant_admits_the_server_and_a_stale_digest_does_not() {
    let golden = golden();
    let project = case(&golden["cases"][0]);
    let dir = tempfile::tempdir().unwrap();
    let paths = rust_cli_paths::StoragePaths::resolve(&Default::default(), dir.path(), dir.path());
    let store = McpTrustStore::beside(&paths.hook_trust_store(None));
    std::fs::create_dir_all(store.path().parent().unwrap()).unwrap();
    std::fs::write(store.path(), golden["store"]["text"].as_str().unwrap()).unwrap();
    let load = store.load().await;
    let (discovery, reviews) = run(&project, &load);
    let trusted: Vec<&str> = reviews
        .iter()
        .filter(|review| review.trusted)
        .map(|review| review.name.as_str())
        .collect();
    assert_eq!(trusted, ["gamma"]);
    assert_eq!(golden["store"]["gammaTrusted"], json!(true));
    let discovery = discovery.unwrap();
    let admitted = admitted(&project.target, Ok(&discovery), &load);
    assert_eq!(admitted.into_iter().collect::<Vec<_>>(), ["gamma"]);
    // Another identity for the same folder is a different workspace.
    let other = Target::new(&project.target.working_directory, Some("remote:else"));
    let other_discovery = discover(
        &other,
        &Inputs {
            user: project.user.as_ref(),
            projects: &project.projects,
            fallback: &project.fallback,
        },
    )
    .unwrap();
    assert!(admitted_names(&other, &other_discovery, &load).is_empty());
}

fn admitted_names(target: &Target, discovery: &Discovery, load: &McpTrustLoad) -> Vec<String> {
    admitted(target, Ok(discovery), load).into_iter().collect()
}

#[test]
fn a_disabled_declaration_is_never_admitted_or_pending() {
    let golden = golden();
    let project = case(&golden["cases"][0]);
    let (discovery, _) = run(&project, &McpTrustLoad::Missing);
    let discovery = discovery.unwrap();
    let beta = discovery.get("beta").unwrap();
    assert!(!beta.enabled());
    let load = McpTrustLoad::Records(vec![rust_cli_platform::local::McpTrustRecord {
        workspace_identity: project.target.identity.clone(),
        server_name: "beta".into(),
        declaration_digest: beta.digest.clone(),
        granted_at: "2026-11-13T00:00:00.000Z".into(),
    }]);
    assert!(admitted_names(&project.target, &discovery, &load).is_empty());
    let reviews = reviews(&project.target, Ok(&discovery), &load).unwrap();
    let banner = admission(&project.target, &reviews);
    // alpha, delta, eps, gamma, zeta are enabled and untrusted; beta is disabled.
    assert_eq!(banner["pendingCount"], json!(5));
    assert_eq!(banner["workspaceIdentity"], json!(project.target.identity));
    assert_eq!(banner["bundleDigest"].as_str().unwrap().len(), 64);
}

#[test]
fn validation_is_strict_like_node() {
    for (value, valid) in [
        (json!({"command": "x"}), true),
        (json!({"command": "x", "extra": 1}), false),
        (json!({"type": "stdio"}), false),
        (json!({"type": "http", "url": "u", "cwd": "x"}), false),
        (json!({"url": "u", "timeoutMs": 0}), false),
        (
            json!({"url": "u", "isolation": "workspace", "protocolVersion": "auto"}),
            true,
        ),
        (
            json!({"url": "u", "oauth": {"type": "client_credentials", "clientId": "a"}}),
            false,
        ),
        (
            json!({"url": "u", "oauth": {"type": "authorization_code"}}),
            true,
        ),
        (json!({"command": "x", "env": {"A": 1}}), false),
        (json!({"type": "ws", "url": "u"}), false),
    ] {
        assert_eq!(validate(&value).is_some(), valid, "{value}");
    }
}

#[test]
fn the_digest_sorts_keys_by_utf16_and_prints_index_keys_first() {
    let value = json!({"b": 1, "a": {"2": true, "10": false, "x": [{"z": 1, "y": 2}]}});
    let text = stringify(&sorted(&value));
    assert_eq!(
        text,
        r#"{"a":{"2":true,"10":false,"x":[{"y":2,"z":1}]},"b":1}"#
    );
}

#[test]
fn host_dtos_are_converted_and_admitted_like_node() {
    let golden = golden();
    let project = case(&golden["cases"][0]);
    let (discovery, reviews) = run(&project, &McpTrustLoad::Missing);
    let discovery = discovery.unwrap();
    let grant = |name: &str| rust_cli_platform::local::McpTrustRecord {
        workspace_identity: project.target.identity.clone(),
        server_name: name.into(),
        declaration_digest: reviews
            .iter()
            .find(|r| r.name == name)
            .unwrap()
            .digest
            .clone(),
        granted_at: "2026-11-13T00:00:00.000Z".into(),
    };
    let load = McpTrustLoad::Records(vec![grant("gamma"), grant("alpha")]);
    let cases = golden["dtoAllows"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for item in cases {
        let (name, converted) = dto_config(&item["dto"]).unwrap();
        assert_eq!(
            Value::Object(converted.clone()),
            item["converted"],
            "{name}"
        );
        let keys: Vec<&String> = converted.keys().collect();
        let node: Vec<&String> = item["converted"].as_object().unwrap().keys().collect();
        assert_eq!(keys, node, "{name}: key order");
        let admitted = allows(&project.target, Ok(&discovery), &load, &name, &converted);
        assert_eq!(json!(admitted), item["allows"], "{name}");
    }
    let unreadable = allows(
        &project.target,
        Err(Unreadable),
        &load,
        "outside",
        &Map::new(),
    );
    assert!(!unreadable);
}
