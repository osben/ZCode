//! `lsp/*` answers (specs/fork-rust-lsp.md "Protocol surface"): Node's order, the strict params check first, then
//! the host check, then the host's answer in the protocol shape.
use std::sync::Mutex;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::lsp::LspStatus;
use rust_cli_protocol_core::rpc::codes;
use serde_json::{Value, json};

use super::*;
use crate::inbound::Inbound;

const METHODS: [&str; 3] = ["lsp/preferences/get", "lsp/preferences/set", "lsp/status"];

fn workspace() -> Value {
    json!({"workspacePath": "/w", "workspaceKey": "/w"})
}

fn valid(method: &str) -> Value {
    match method {
        "lsp/preferences/set" => json!({"workspace": workspace(),
            "patch": {"enabled": false, "diagnosticsAfterEdit": {"p/ts": null, "p/rs": true}}}),
        _ => json!({"workspace": workspace()}),
    }
}

/// Records what the protocol asked for and answers fixed values.
#[derive(Default)]
struct FakeHost {
    patches: Mutex<Vec<LspPreferencesPatch>>,
    workspaces: Mutex<Vec<LspWorkspace>>,
    fail: bool,
}

fn prefs() -> LspPreferences {
    LspPreferences {
        enabled: false,
        diagnostics_after_edit: json!({"p/rs": true})
            .as_object()
            .cloned()
            .unwrap_or_default(),
    }
}

#[async_trait]
impl LanguageServers for FakeHost {
    async fn preferences(&self) -> Result<LspPreferences, String> {
        if self.fail {
            return Err("disk is gone".to_owned());
        }
        Ok(prefs())
    }

    async fn set_preferences(&self, patch: LspPreferencesPatch) -> Result<LspPreferences, String> {
        self.patches.lock_unpoisoned().push(patch);
        Ok(prefs())
    }

    async fn status(&self, workspace: &LspWorkspace) -> Result<LspStatus, String> {
        self.workspaces.lock_unpoisoned().push(workspace.clone());
        let entry = LspServerStatus {
            server_id: "typescript-lsp@zcode-plugins-official/typescript".to_owned(),
            plugin_id: "typescript-lsp@zcode-plugins-official".to_owned(),
            server_name: "typescript".to_owned(),
            command: "typescript-language-server".to_owned(),
            extensions: vec![".ts".to_owned(), ".js".to_owned()],
            installed: false,
            state: "not_installed",
            diagnostics_mode: "unknown",
            diagnostics_after_edit: true,
            restarts: 0,
            last_error_code: None,
        };
        let crashed = LspServerStatus {
            state: "crashed",
            last_error_code: Some("exit".to_owned()),
            ..entry.clone()
        };
        Ok(LspStatus {
            enabled: true,
            servers: vec![entry, crashed],
        })
    }
}

/// Node `Handler::request` order: [`Inbound::method`] runs before the dispatch.
async fn answer(
    host: Option<&Arc<dyn LanguageServers>>,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    Inbound::get().method(method, params)?;
    dispatch(host, method, params)
        .await
        .expect("an lsp method is answered")
}

#[tokio::test]
async fn without_a_host_a_valid_call_answers_minus_32000() {
    for method in METHODS {
        let error = answer(None, method, &valid(method))
            .await
            .expect_err(method);
        assert_eq!(error.code, -32000, "{method}");
        assert_eq!(
            error.message, "Language server support is not available in this runtime",
            "{method}"
        );
    }
}

#[tokio::test]
async fn preferences_are_answered_without_the_version() {
    let host: Arc<dyn LanguageServers> = Arc::new(FakeHost::default());
    let expected = json!({"enabled": false, "diagnosticsAfterEdit": {"p/rs": true}});
    let got = answer(
        Some(&host),
        "lsp/preferences/get",
        &valid("lsp/preferences/get"),
    )
    .await;
    assert_eq!(got.unwrap(), expected);
    let set = answer(
        Some(&host),
        "lsp/preferences/set",
        &valid("lsp/preferences/set"),
    )
    .await;
    assert_eq!(set.unwrap(), expected);
}

#[tokio::test]
async fn the_patch_reaches_the_host_with_null_as_a_removal() {
    let fake = Arc::new(FakeHost::default());
    let host: Arc<dyn LanguageServers> = fake.clone();
    answer(
        Some(&host),
        "lsp/preferences/set",
        &valid("lsp/preferences/set"),
    )
    .await
    .unwrap();
    let only_enabled = json!({"workspace": workspace(), "patch": {"enabled": true}});
    answer(Some(&host), "lsp/preferences/set", &only_enabled)
        .await
        .unwrap();
    assert_eq!(
        *fake.patches.lock_unpoisoned(),
        [
            LspPreferencesPatch {
                enabled: Some(false),
                diagnostics_after_edit: vec![
                    ("p/ts".to_owned(), None),
                    ("p/rs".to_owned(), Some(true))
                ],
            },
            LspPreferencesPatch {
                enabled: Some(true),
                diagnostics_after_edit: Vec::new(),
            }
        ]
    );
}

#[tokio::test]
async fn status_entries_follow_the_protocol_schema() {
    let fake = Arc::new(FakeHost::default());
    let host: Arc<dyn LanguageServers> = fake.clone();
    let params = json!({"workspace": {"workspacePath": "/w", "workspaceKey": "k", "workspaceIdentity": "remote:x"}});
    let status = answer(Some(&host), "lsp/status", &params).await.unwrap();
    assert_eq!(
        status,
        json!({"enabled": true, "servers": [
            {"serverId": "typescript-lsp@zcode-plugins-official/typescript",
             "pluginId": "typescript-lsp@zcode-plugins-official", "serverName": "typescript",
             "command": "typescript-language-server", "extensions": [".ts", ".js"], "installed": false,
             "state": "not_installed", "diagnosticsMode": "unknown", "diagnosticsAfterEdit": true, "restarts": 0},
            {"serverId": "typescript-lsp@zcode-plugins-official/typescript",
             "pluginId": "typescript-lsp@zcode-plugins-official", "serverName": "typescript",
             "command": "typescript-language-server", "extensions": [".ts", ".js"], "installed": false,
             "state": "crashed", "diagnosticsMode": "unknown", "diagnosticsAfterEdit": true, "restarts": 0,
             "lastErrorCode": "exit"}
        ]})
    );
    assert_eq!(
        *fake.workspaces.lock_unpoisoned(),
        [LspWorkspace {
            path: "/w".to_owned(),
            identity: Some("remote:x".to_owned())
        }]
    );
}

#[tokio::test]
async fn a_host_failure_is_an_internal_error_with_its_message() {
    let host: Arc<dyn LanguageServers> = Arc::new(FakeHost {
        fail: true,
        ..FakeHost::default()
    });
    let error = answer(
        Some(&host),
        "lsp/preferences/get",
        &valid("lsp/preferences/get"),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (codes::INTERNAL_ERROR, "disk is gone")
    );
}

#[tokio::test]
async fn invalid_params_are_refused_before_the_host_check() {
    for method in METHODS {
        for params in [
            Value::Null,
            json!({}),
            json!({"workspace": {"workspacePath": "/w"}}),
            json!({"workspace": {"workspacePath": "", "workspaceKey": "/w"}}),
            json!({"workspace": workspace(), "extra": 1}),
        ] {
            let error = answer(None, method, &params).await.expect_err(method);
            assert_eq!(error.code, codes::INVALID_PARAMS, "{method} {params}");
        }
    }
    for patch in [
        Value::Null,
        json!({"enabled": "yes"}),
        json!({"diagnosticsAfterEdit": {"": true}}),
        json!({"diagnosticsAfterEdit": {"p/ts": 1}}),
        json!({"other": true}),
    ] {
        let params = json!({"workspace": workspace(), "patch": patch});
        let error = answer(None, "lsp/preferences/set", &params)
            .await
            .expect_err("bad patch");
        assert_eq!(error.code, codes::INVALID_PARAMS, "{patch}");
    }
    let missing = answer(
        None,
        "lsp/preferences/set",
        &json!({"workspace": workspace()}),
    )
    .await;
    assert_eq!(missing.unwrap_err().code, codes::INVALID_PARAMS);
}

#[tokio::test]
async fn other_methods_are_not_answered_here() {
    assert!(dispatch(None, "lsp/restart", &Value::Null).await.is_none());
    assert!(dispatch(None, "plugins/list", &Value::Null).await.is_none());
}
