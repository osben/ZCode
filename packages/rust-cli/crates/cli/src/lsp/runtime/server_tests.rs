use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::{
    PULL_DIAGNOSTICS, Registrations, Registry, extname, initialize_params, server_requests,
    settings_section, workspace_folders,
};
use crate::lsp::runtime::test_server;

#[test]
fn initialize_params_name_the_workspace_and_its_extra_folder() {
    let mut server = test_server("ts");
    server.workspace_folder = Some("packages/app".to_owned());
    server.initialization_options = Some(json!({"x": 1}));
    let folders = workspace_folders(&server, "/w/my repo", false).unwrap();
    let params = initialize_params(&server, "/w/my repo", &folders, 42, false);
    assert_eq!(params["processId"], 42);
    assert_eq!(params["clientInfo"], json!({"name": "zcode"}));
    assert_eq!(params["rootUri"], "file:///w/my%20repo");
    assert_eq!(params["rootPath"], "/w/my repo");
    assert_eq!(
        params["workspaceFolders"],
        json!([
            {"uri": "file:///w/my%20repo", "name": "my repo"},
            {"uri": "file:///w/my%20repo/packages/app", "name": "app"},
        ])
    );
    assert_eq!(params["initializationOptions"], json!({"x": 1}));
    assert_eq!(
        params["capabilities"]["general"]["positionEncodings"],
        json!(["utf-16"])
    );
    // The same folder is not repeated; the root is named by its separator; no options means no key.
    server.workspace_folder = Some(".".to_owned());
    server.initialization_options = None;
    let folders = workspace_folders(&server, "/", false).unwrap();
    assert_eq!(folders, [json!({"uri": "file:///", "name": "/"})]);
    assert!(
        initialize_params(&server, "/", &folders, 1, false)
            .get("initializationOptions")
            .is_none()
    );
}

#[test]
fn a_workspace_folder_outside_the_workspace_fails_the_start() {
    let mut server = test_server("ts");
    server.workspace_folder = Some("../other".to_owned());
    let error = workspace_folders(&server, "/w/a", false).unwrap_err();
    assert_eq!(error.code, "lsp_server_start_failed");
    assert_eq!(
        error.message,
        "workspaceFolder \"../other\" resolves outside the workspace"
    );
}

#[test]
fn configuration_sections_are_dot_paths_into_settings() {
    let settings = json!({"ts": {"format": {"semi": false}, "nil": null}});
    let lookup = |section: Option<Value>| settings_section(Some(&settings), section.as_ref());
    assert_eq!(lookup(Some(json!("ts.format.semi"))), json!(false));
    assert_eq!(lookup(Some(json!("ts.missing"))), Value::Null);
    assert_eq!(lookup(Some(json!("ts.nil"))), Value::Null);
    assert_eq!(lookup(None), settings);
    assert_eq!(lookup(Some(json!(""))), settings);
    assert_eq!(lookup(Some(json!(3))), Value::Null);
    assert_eq!(settings_section(None, None), Value::Null);
}

#[test]
fn server_requests_keep_registrations_and_answer_folders() {
    let registrations = Arc::new(Mutex::new(Registrations::default()));
    let folders = vec![json!({"uri": "file:///w", "name": "w"})];
    let answer = server_requests(
        Some(json!({"a": 1})),
        folders.clone(),
        Arc::clone(&registrations),
    );
    assert_eq!(
        answer(
            "workspace/configuration",
            &json!({"items": [{"section": "a"}, {}]})
        )
        .unwrap(),
        json!([1, {"a": 1}])
    );
    let register = json!({"registrations": [{"id": "1", "method": PULL_DIAGNOSTICS, "registerOptions": {"identifier": "ts"}}]});
    assert_eq!(
        answer("client/registerCapability", &register).unwrap(),
        Value::Null
    );
    assert_eq!(
        registrations.lock().unwrap().options_for(PULL_DIAGNOSTICS),
        Some(json!({"identifier": "ts"}))
    );
    // Both spellings of the unregister list.
    answer(
        "client/unregisterCapability",
        &json!({"unregisterations": [{"id": "1"}]}),
    )
    .unwrap();
    assert_eq!(
        registrations.lock().unwrap().options_for(PULL_DIAGNOSTICS),
        None
    );
    answer(
        "client/registerCapability",
        &json!({"registrations": [{"id": "2", "method": PULL_DIAGNOSTICS}]}),
    )
    .unwrap();
    assert_eq!(
        registrations.lock().unwrap().options_for(PULL_DIAGNOSTICS),
        Some(json!({}))
    );
    answer(
        "client/unregisterCapability",
        &json!({"unregistrations": [{"id": "2"}]}),
    )
    .unwrap();
    assert_eq!(
        registrations.lock().unwrap().options_for(PULL_DIAGNOSTICS),
        None
    );
    assert_eq!(
        answer("window/workDoneProgress/create", &json!({})).unwrap(),
        Value::Null
    );
    assert_eq!(
        answer("workspace/workspaceFolders", &Value::Null).unwrap(),
        json!(folders)
    );
    assert_eq!(
        answer("window/showDocument", &json!({})).unwrap_err(),
        (
            -32_601,
            "client does not implement window/showDocument".to_owned()
        )
    );
}

#[test]
fn files_find_their_server_by_extension() {
    assert_eq!(extname("/w/a.test.ts"), ".ts");
    assert_eq!(extname("/w/.bashrc"), "");
    assert_eq!(extname("/w.d/Makefile"), "");
    let mut upper = test_server("upper");
    upper.extension_to_language = vec![(".TSX".to_owned(), "typescriptreact".to_owned())];
    let registry = Registry::new(vec![test_server("ts"), upper]);
    let found = registry.for_file("/w/a.ts").unwrap();
    assert_eq!(
        (found.server.id.as_str(), found.language_id.as_str()),
        ("p/ts", "typescript")
    );
    // No exact `.tsx`: the lowercase fallback.
    assert_eq!(registry.for_file("/w/a.tsx").unwrap().server.id, "p/upper");
    assert_eq!(registry.for_file("/w/A.TS").unwrap().server.id, "p/ts");
    assert!(registry.for_file("/w/a.rs").is_none());
}
