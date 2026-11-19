//! JSON-RPC 客户端：请求配对、服务器请求的回答、通知、关闭（ext.md §3.3）。

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::mcp::{McpConnect, McpTransportConfig};

use super::*;
use crate::test_support::{FakeMcp, server, workspace};

async fn connected(fake: &Arc<FakeMcp>, scope: &TaskScope) -> (Arc<Client>, NoticeReceiver) {
    let request = McpConnect {
        server: "s".to_owned(),
        transport: McpTransportConfig::http(
            "https://mcp.example.com".to_owned(),
            Default::default(),
        ),
    };
    let transport: Arc<dyn McpTransport> = fake.clone();
    let id = transport.connect(&workspace(), request).await.unwrap();
    Client::start(
        transport,
        id,
        &scope.spawner(),
        vec!["/Users/dev/project".to_owned()],
    )
}

#[tokio::test]
async fn requests_pair_with_responses_and_errors() {
    let fake = Arc::new(FakeMcp::default().with(
        "s",
        server(json!({}), None, |method, params| match method {
            "echo" => Some(Ok(params.clone())),
            "boom" => Some(Err((-32000, "bad".to_owned()))),
            _ => None,
        }),
    ));
    let scope = TaskScope::root("test", |_| {});
    let (client, _notices) = connected(&fake, &scope).await;
    let never = CancellationToken::new();
    let long = Duration::from_secs(5);
    assert_eq!(
        client.request("echo", json!({"a": 1}), long, &never).await,
        Ok(json!({"a": 1}))
    );
    assert_eq!(
        client.request("boom", json!({}), long, &never).await,
        Err(RpcError::Server {
            code: -32000,
            message: "bad".to_owned()
        })
    );
    // 不回答的请求：取消时发 notifications/cancelled。
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        client.request("hang", json!({}), long, &cancel).await,
        Err(RpcError::Cancelled)
    );
    let sent = fake.received();
    let cancelled = sent.last().unwrap();
    assert_eq!(cancelled.1["method"], "notifications/cancelled");
    assert_eq!(cancelled.1["params"]["requestId"], 2);
}

#[tokio::test]
async fn server_requests_notifications_and_close() {
    let fake = Arc::new(FakeMcp::default().with("s", server(json!({}), None, |_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let (client, mut notices) = connected(&fake, &scope).await;
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "id": 7, "method": "roots/list"}),
    );
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "id": 8, "method": "sampling/createMessage"}),
    );
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}),
    );
    assert_eq!(
        notices.recv().await,
        Some(Notice::ListChanged("tools".to_owned()))
    );
    let replies: Vec<Value> = fake
        .received()
        .into_iter()
        .map(|(_, message)| message)
        .collect();
    assert_eq!(
        replies[0],
        json!({"jsonrpc": "2.0", "id": 7, "result": {"roots": [{"uri": "file:///Users/dev/project"}]}})
    );
    assert_eq!(replies[1]["error"]["code"], -32601);
    // 关闭：等待中的请求失败，之后的请求立即失败。
    let pending = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .request(
                    "hang",
                    json!({}),
                    Duration::from_secs(5),
                    &CancellationToken::new(),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    fake.drop_server("s", true);
    assert!(matches!(pending.await.unwrap(), Err(RpcError::Closed(_))));
    assert_eq!(
        notices.recv().await,
        Some(Notice::Closed {
            reason: Some("gone".to_owned()),
            session_expired: true
        })
    );
    assert!(client.is_closed());
}

/// F7 PR 4: a server's resource notifications reach the connection task as their own notices, the update with its uri.
#[tokio::test]
async fn resource_notifications_are_noticed_with_their_uri() {
    let fake = Arc::new(FakeMcp::default().with("s", server(json!({}), None, |_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let (_client, mut notices) = connected(&fake, &scope).await;
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {"uri": "ui://a"}}),
    );
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "method": "notifications/resources/list_changed"}),
    );
    assert_eq!(
        notices.recv().await,
        Some(Notice::ResourceUpdated("ui://a".to_owned()))
    );
    assert_eq!(notices.recv().await, Some(Notice::ResourceListChanged));
}

/// F7 PR 4: an update without a uri is not a notice (Node `if (typeof uri !== "string") return`).
#[tokio::test]
async fn an_update_without_a_uri_is_not_noticed() {
    let fake = Arc::new(FakeMcp::default().with("s", server(json!({}), None, |_, _| None)));
    let scope = TaskScope::root("test", |_| {});
    let (client, mut notices) = connected(&fake, &scope).await;
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "method": "notifications/resources/updated", "params": {}}),
    );
    fake.push(
        "s",
        json!({"jsonrpc": "2.0", "method": "notifications/resources/list_changed"}),
    );
    // The list change arrives after the malformed update, so the first notice is the list change.
    assert_eq!(notices.recv().await, Some(Notice::ResourceListChanged));
    drop(client);
}

/// 工作线 F57：`roots/list` 的 URI 同 `url.pathToFileURL(root).href`。POSIX 的期望值是用 Bun 1.3.11
/// 与 Node 24 实测的，两者逐字相同；Windows 的是 Node 24 的 `pathToFileURL(p, {windows: true})`（`C:\`
/// 取 Windows 上的结果 `file:///C:/`）。以前不编码、UNC 写成 `file:////server/share`。
#[test]
fn root_uris_are_node_file_urls() {
    for (path, expected) in [
        ("/Users/dev/project", "file:///Users/dev/project"),
        ("/a b/c", "file:///a%20b/c"),
        ("/x#y?z%w", "file:///x%23y%3Fz%25w"),
        ("/\u{fc}/\u{e9}", "file:///%C3%BC/%C3%A9"),
        ("/a\\b", "file:///a%5Cb"),
        ("/a\tb", "file:///a%09b"),
        (
            "/a\"<>`{}|^[]@!$&'()*+,;=:~",
            "file:///a%22%3C%3E%60%7B%7D%7C%5E%5B%5D@!$&'()*+,;=:%7E",
        ),
        ("/a\u{7f}-._", "file:///a%7F-._"),
        (r"C:\Work", "file:///C:/Work"),
        (r"C:\a b\c", "file:///C:/a%20b/c"),
        (r"c:\x#y?z%w", "file:///c:/x%23y%3Fz%25w"),
        (r"C:\", "file:///C:/"),
        (r"C:\a/b", "file:///C:/a/b"),
        (r"\\server\share\repo", "file://server/share/repo"),
        (r"\\SERVER\Share\a b", "file://server/Share/a%20b"),
        (r"\\?\UNC\server\share\x", "file://server/share/x"),
        (r"\\?\C:\x", "file:///C:/x"),
    ] {
        assert_eq!(file_uri(path), expected, "{path}");
    }
}

/// 按 href 去重（工作区根也出现在 `additionalDirectories` 里时只给一次）。
#[test]
fn root_uris_are_listed_once() {
    let roots = vec!["/w".to_owned(), "/x".to_owned(), "/w".to_owned()];
    assert_eq!(
        answer("roots/list", &roots).unwrap(),
        json!({"roots": [{"uri": "file:///w"}, {"uri": "file:///x"}]})
    );
}

/// F3b(c) MCP elicitation on the connection (specs/fork-rust-node-helper.md). The question is asked only while a tool
/// call of this connection is in flight; otherwise, or for a mode other than form, the answer is a decline.
mod elicitation {
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use rust_cli_base::sync::LockUnpoisoned;
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::orchestration::{
        Answer, InteractionAnswer, InteractionRequest, Interactions, McpElicitationAnswer,
        OrchestrationError, QuestionAnswer,
    };
    use rust_cli_kernel_api::testing::ScriptedInteractions;
    use serde_json::Map;

    use super::*;
    use crate::mcp::rpc::ElicitationCall;
    use crate::test_support::{FakeMcp, server, workspace};

    fn schema() -> Value {
        json!({"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    }

    fn name_params() -> Value {
        json!({"message": "Name?", "requestedSchema": schema()})
    }

    fn content(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn fake() -> Arc<FakeMcp> {
        Arc::new(FakeMcp::default().with("s", server(json!({}), None, |_, _| None)))
    }

    async fn connected(fake: &Arc<FakeMcp>, scope: &TaskScope) -> Arc<Client> {
        let request = McpConnect {
            server: "s".to_owned(),
            transport: McpTransportConfig::http(
                "https://mcp.example.com".to_owned(),
                Default::default(),
            ),
        };
        let transport: Arc<dyn McpTransport> = fake.clone();
        let id = transport.connect(&workspace(), request).await.unwrap();
        Client::start(transport, id, &scope.spawner(), Vec::new()).0
    }

    fn elicit(fake: &FakeMcp, id: u64, params: Value) {
        fake.push(
            "s",
            json!({"jsonrpc": "2.0", "id": id, "method": "elicitation/create", "params": params}),
        );
    }

    /// The client's answer to the server's request `id`, once it is sent.
    async fn answered(fake: &FakeMcp, id: u64) -> Value {
        for _ in 0..400 {
            let reply = fake
                .received()
                .into_iter()
                .map(|(_, message)| message)
                .find(|message| message["id"] == id && message.get("method").is_none());
            if let Some(reply) = reply {
                return reply;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no answer to request {id}");
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the condition never held");
    }

    fn in_flight(
        tool_use: &str,
        interactions: Arc<dyn Interactions>,
        cancel: CancellationToken,
    ) -> ElicitationCall {
        ElicitationCall {
            tool_use: ToolUseId::new(tool_use),
            server: "s".to_owned(),
            interactions,
            cancel,
        }
    }

    /// An ask that never gets an answer; it records the asks and the withdrawn ones.
    #[derive(Default)]
    struct Hanging {
        asked: Mutex<usize>,
        withdrawn: Mutex<Vec<ToolUseId>>,
    }

    #[async_trait]
    impl Interactions for Hanging {
        async fn ask(
            &self,
            _request: InteractionRequest,
        ) -> Result<InteractionAnswer, OrchestrationError> {
            *self.asked.lock_unpoisoned() += 1;
            std::future::pending().await
        }

        async fn cancel_ask(&self, tool_use: &ToolUseId) {
            self.withdrawn.lock_unpoisoned().push(tool_use.clone());
        }

        fn lasting(&self) -> Option<Arc<dyn Interactions>> {
            None
        }
    }

    #[tokio::test]
    async fn an_elicitation_without_a_call_is_declined() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let _client = connected(&fake, &scope).await;
        elicit(&fake, 9, name_params());
        assert_eq!(
            answered(&fake, 9).await["result"],
            json!({"action": "decline"})
        );
    }

    #[tokio::test]
    async fn an_accepted_answer_reaches_the_server_with_its_content() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        let interactions = Arc::new(ScriptedInteractions::new([Answer::McpElicitation(
            McpElicitationAnswer::Accept {
                content: content(json!({"name": "Ada"})),
            },
        )]));
        let _call = client.enter_call(in_flight(
            "toolu_1",
            interactions.clone(),
            CancellationToken::new(),
        ));
        elicit(&fake, 9, name_params());
        assert_eq!(
            answered(&fake, 9).await["result"],
            json!({"action": "accept", "content": {"name": "Ada"}})
        );
        assert_eq!(
            interactions.asked(),
            vec![InteractionRequest::McpElicitation {
                tool_use: ToolUseId::new("toolu_1"),
                server: "s".to_owned(),
                message: "Name?".to_owned(),
                requested_schema: schema(),
                origin: None,
            }]
        );
    }

    #[tokio::test]
    async fn decline_and_cancel_answers_reach_the_server() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        for (id, answer, expected) in [
            (10, McpElicitationAnswer::Decline, "decline"),
            (11, McpElicitationAnswer::Cancel, "cancel"),
        ] {
            let interactions =
                Arc::new(ScriptedInteractions::always(Answer::McpElicitation(answer)));
            let _call =
                client.enter_call(in_flight("toolu_1", interactions, CancellationToken::new()));
            elicit(&fake, id, name_params());
            assert_eq!(
                answered(&fake, id).await["result"],
                json!({"action": expected})
            );
        }
    }

    #[tokio::test]
    async fn a_failed_question_or_another_answer_kind_declines() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        // No scripted answer: the ask fails.
        let failed = Arc::new(ScriptedInteractions::new([]));
        let call = client.enter_call(in_flight("toolu_1", failed, CancellationToken::new()));
        elicit(&fake, 20, name_params());
        assert_eq!(
            answered(&fake, 20).await["result"],
            json!({"action": "decline"})
        );
        drop(call);
        // An answer of another kind is not this question's answer.
        let other = Arc::new(ScriptedInteractions::always(Answer::Question(
            QuestionAnswer::Declined,
        )));
        let _call = client.enter_call(in_flight("toolu_2", other, CancellationToken::new()));
        elicit(&fake, 21, name_params());
        assert_eq!(
            answered(&fake, 21).await["result"],
            json!({"action": "decline"})
        );
    }

    #[tokio::test]
    async fn a_mode_other_than_form_is_declined_without_asking() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        let interactions = Arc::new(ScriptedInteractions::allowing());
        let _call = client.enter_call(in_flight(
            "toolu_1",
            interactions.clone(),
            CancellationToken::new(),
        ));
        elicit(
            &fake,
            30,
            json!({"mode": "url", "message": "Open?", "url": "https://example.com", "elicitationId": "e1"}),
        );
        assert_eq!(
            answered(&fake, 30).await["result"],
            json!({"action": "decline"})
        );
        assert!(interactions.asked().is_empty());
    }

    #[tokio::test]
    async fn ending_the_call_withdraws_the_question_and_answers_cancel() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        let hanging = Arc::new(Hanging::default());
        let call = client.enter_call(in_flight(
            "toolu_1",
            hanging.clone(),
            CancellationToken::new(),
        ));
        elicit(&fake, 40, name_params());
        wait_until(|| *hanging.asked.lock_unpoisoned() == 1).await;
        drop(call);
        assert_eq!(
            answered(&fake, 40).await["result"],
            json!({"action": "cancel"})
        );
        assert_eq!(
            *hanging.withdrawn.lock_unpoisoned(),
            vec![ToolUseId::new("toolu_1")]
        );
    }

    #[tokio::test]
    async fn cancelling_the_call_withdraws_the_question_and_answers_cancel() {
        let fake = fake();
        let scope = TaskScope::root("test", |_| {});
        let client = connected(&fake, &scope).await;
        let hanging = Arc::new(Hanging::default());
        let cancel = CancellationToken::new();
        let _call = client.enter_call(in_flight("toolu_1", hanging.clone(), cancel.clone()));
        elicit(&fake, 50, name_params());
        wait_until(|| *hanging.asked.lock_unpoisoned() == 1).await;
        cancel.cancel();
        assert_eq!(
            answered(&fake, 50).await["result"],
            json!({"action": "cancel"})
        );
        assert_eq!(
            *hanging.withdrawn.lock_unpoisoned(),
            vec![ToolUseId::new("toolu_1")]
        );
    }
}

/// F3b(c) PR 2: a helper-hosted server's question, relayed by the helper (`helper/elicitation`). It is asked and answered
/// as the connection's own question is, and the helper's abandon of the request (its call ended, or the turn was
/// cancelled) withdraws it.
mod helper_relay {
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use rust_cli_base::sync::LockUnpoisoned;
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::orchestration::{
        Answer, InteractionAnswer, InteractionRequest, Interactions, McpElicitationAnswer,
        OrchestrationError, QuestionAnswer,
    };
    use rust_cli_kernel_api::testing::ScriptedInteractions;
    use serde_json::Map;

    use super::*;

    fn params() -> Value {
        json!({"message": "Name?", "requestedSchema": {"type": "object"}})
    }

    fn content(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    /// The helper's answer for `toolu_1` on server `s`, with the request's cancel as `withdrawn`.
    async fn relayed(
        interactions: Arc<dyn Interactions>,
        params: Value,
        withdrawn: CancellationToken,
    ) -> Value {
        helper_elicitation_answer(
            interactions,
            ToolUseId::new("toolu_1"),
            "s".to_owned(),
            &params,
            withdrawn,
        )
        .await
    }

    /// An ask that never gets an answer; it records the asks and the withdrawn ones.
    #[derive(Default)]
    struct Hanging {
        asked: Mutex<usize>,
        withdrawn: Mutex<Vec<ToolUseId>>,
    }

    #[async_trait]
    impl Interactions for Hanging {
        async fn ask(
            &self,
            _request: InteractionRequest,
        ) -> Result<InteractionAnswer, OrchestrationError> {
            *self.asked.lock_unpoisoned() += 1;
            std::future::pending().await
        }

        async fn cancel_ask(&self, tool_use: &ToolUseId) {
            self.withdrawn.lock_unpoisoned().push(tool_use.clone());
        }

        fn lasting(&self) -> Option<Arc<dyn Interactions>> {
            None
        }
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the condition never held");
    }

    #[tokio::test]
    async fn an_accepted_answer_reaches_the_helper_with_its_content() {
        let interactions = Arc::new(ScriptedInteractions::new([Answer::McpElicitation(
            McpElicitationAnswer::Accept {
                content: content(json!({"name": "Ada"})),
            },
        )]));
        let result = relayed(interactions.clone(), params(), CancellationToken::new()).await;
        assert_eq!(
            result,
            json!({"action": "accept", "content": {"name": "Ada"}})
        );
        assert_eq!(
            interactions.asked(),
            vec![InteractionRequest::McpElicitation {
                tool_use: ToolUseId::new("toolu_1"),
                server: "s".to_owned(),
                message: "Name?".to_owned(),
                requested_schema: json!({"type": "object"}),
                origin: None,
            }]
        );
    }

    #[tokio::test]
    async fn decline_and_cancel_answers_reach_the_helper() {
        for (answer, expected) in [
            (McpElicitationAnswer::Decline, "decline"),
            (McpElicitationAnswer::Cancel, "cancel"),
        ] {
            let interactions =
                Arc::new(ScriptedInteractions::always(Answer::McpElicitation(answer)));
            let result = relayed(interactions, params(), CancellationToken::new()).await;
            assert_eq!(result, json!({"action": expected}));
        }
    }

    #[tokio::test]
    async fn a_failed_question_or_another_answer_kind_declines() {
        let failed = Arc::new(ScriptedInteractions::new([]));
        assert_eq!(
            relayed(failed, params(), CancellationToken::new()).await,
            json!({"action": "decline"})
        );
        let other = Arc::new(ScriptedInteractions::always(Answer::Question(
            QuestionAnswer::Declined,
        )));
        assert_eq!(
            relayed(other, params(), CancellationToken::new()).await,
            json!({"action": "decline"})
        );
    }

    #[tokio::test]
    async fn a_mode_other_than_form_is_declined_without_asking() {
        let interactions = Arc::new(ScriptedInteractions::allowing());
        let url = json!({"mode": "url", "message": "Open?", "url": "https://example.com"});
        assert_eq!(
            relayed(interactions.clone(), url, CancellationToken::new()).await,
            json!({"action": "decline"})
        );
        assert!(interactions.asked().is_empty());
    }

    /// The call ended while its question is open: the helper abandons the request, the question is withdrawn and the
    /// server gets `cancel`.
    #[tokio::test]
    async fn an_abandoned_request_withdraws_the_open_question_and_answers_cancel() {
        let hanging = Arc::new(Hanging::default());
        let interactions: Arc<dyn Interactions> = hanging.clone();
        let withdrawn = CancellationToken::new();
        let asking = tokio::spawn(relayed(interactions, params(), withdrawn.clone()));
        wait_until(|| *hanging.asked.lock_unpoisoned() == 1).await;
        withdrawn.cancel();
        assert_eq!(asking.await.unwrap(), json!({"action": "cancel"}));
        assert_eq!(
            *hanging.withdrawn.lock_unpoisoned(),
            vec![ToolUseId::new("toolu_1")]
        );
    }
}

/// F3b(c) PR 2: the answer shapes the shared contract (protocol-zcode's helper_elicitation_contract.json, which the TS
/// relay test reads too) names, for the three kinds Rust returns to the helper.
mod helper_contract {
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::orchestration::{Answer, McpElicitationAnswer};
    use rust_cli_kernel_api::testing::ScriptedInteractions;

    use super::*;

    const CONTRACT: &str =
        include_str!("../../../protocol-zcode/src/fork/helper_elicitation_contract.json");

    #[tokio::test]
    async fn rust_answers_the_contracts_answer_shapes() {
        let contract: Value = serde_json::from_str(CONTRACT).expect("the contract is JSON");
        let accept_content = contract["answers"]["accept"]["content"]
            .as_object()
            .expect("an object")
            .clone();
        let answers = [
            (
                "accept",
                Answer::McpElicitation(McpElicitationAnswer::Accept {
                    content: accept_content,
                }),
            ),
            (
                "decline",
                Answer::McpElicitation(McpElicitationAnswer::Decline),
            ),
            (
                "cancel",
                Answer::McpElicitation(McpElicitationAnswer::Cancel),
            ),
        ];
        for (name, answer) in answers {
            let got = helper_elicitation_answer(
                Arc::new(ScriptedInteractions::always(answer)),
                ToolUseId::new("toolu_1"),
                contract["question"]["serverName"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                &contract["request"],
                CancellationToken::new(),
            )
            .await;
            assert_eq!(got, contract["answers"][name], "the {name} answer");
        }
    }
}
