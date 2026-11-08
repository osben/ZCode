//! 旧方法 `session/read`（docs/specs/rust-cli/app-protocol.md §5.1）：任务索引同步建搜索文本（`contentProfile: index`）。
//! 给旧的会话快照形状（`zcodeSessionStateSnapshotSchema`），消息只带真人输入与 assistant 正文（index 形状本来就去掉
//! 工具与思考的大载荷）。

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{Message, UserOrigin};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::projection::text_of;
use crate::server::{Server, kernel_error};

pub async fn read(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = SessionId::new(params["sessionId"].as_str().unwrap_or_default());
    let view = match server.bridge.get(&session) {
        Some(live) => live.handle.view().await,
        None => server.kernel.session_snapshot(&session).await,
    }
    .map_err(|error| kernel_error(&error))?;
    let id = view.meta.id.as_str();
    let at = view.meta.created_at_ms;
    let workspace = view.meta.workspace.root.as_str();
    let mut messages = Vec::new();
    // Fork: the desktop Host validates `messages[].info` strictly (Node message shape), so every
    // message carries the main agent name and assistants carry parent, path, cost and tokens.
    let mut last_user_id: Option<String> = None;
    for (index, message) in view.messages.iter().enumerate() {
        let (role, body, message_id) = match message {
            Message::User(user) if user.origin == UserOrigin::Human => {
                ("user", text_of(&user.content), user.id.as_str())
            }
            Message::Assistant(assistant) => (
                "assistant",
                text_of(&assistant.content),
                assistant.id.as_str(),
            ),
            _ => continue,
        };
        if body.is_empty() {
            continue;
        }
        let mut info = json!({"messageId": message_id, "role": role, "sessionId": id,
            "time": {"created": at}, "agent": "zcode-agent"});
        if role == "user" {
            last_user_id = Some(message_id.to_owned());
        } else {
            info["parentMessageId"] = json!(last_user_id.as_deref().unwrap_or(message_id));
            info["path"] = json!({"cwd": workspace, "root": workspace});
            info["cost"] = json!(0);
            info["tokens"] = json!({"input": 0, "output": 0, "reasoning": 0,
                "cache": {"read": 0, "write": 0}});
        }
        messages.push(json!({
            "info": info,
            "parts": [{"messageId": message_id, "partId": format!("{message_id}:part:{index}"),
                "sessionId": id, "type": "text", "text": body}],
        }));
    }
    let mode = view.mode.node_name();
    let status = if view.running { "running" } else { "idle" };
    let model = json!({"providerId": view.selection.provider, "modelId": view.selection.model});
    let mut current = model.clone();
    if let Some(level) = &view.selection.reasoning {
        current["options"] = json!({"reasoningLevel": level});
    }
    let (used, size) = view
        .context_usage
        .as_ref()
        .map_or((0, 0), |usage| (usage.used_tokens, usage.max_tokens));
    Ok(json!({
        "protocol": {"name": "ZCode Protocol", "version": 1},
        "session": {
            "createdAt": at,
            "mode": mode,
            "model": model,
            "traceId": view.meta.trace.as_str(),
            "sessionId": id,
            "sessionKind": "interactive",
            "status": status,
            "target": null,
            "title": view.meta.title,
            "updatedAt": at,
            "workspace": {"workspacePath": workspace, "workspaceKey": workspace},
        },
        "settings": {
            "mode": {"current": mode},
            "model": {"available": [], "current": current},
            "permission": {"mode": mode},
            "thoughtLevel": {"available": [], "current": view.selection.reasoning.clone().unwrap_or_default(),
                "enabled": view.selection.reasoning.is_some()},
        },
        "projection": {
            "activeToolCalls": [],
            "backgroundJobs": [],
            "contextUsed": used,
            "contextWindow": size,
            "mode": mode,
            "pendingPermissions": [],
            "sessionId": id,
            "status": status,
            "target": null,
            "totalTokenCount": used,
            "turnCount": messages.iter().filter(|message| message["info"]["role"] == "user").count(),
        },
        "runtime": {
            "eventSeq": view.last_seq,
            "pendingRequestIds": [],
            "goalVerifications": [],
            "goalVerificationTimeline": [],
            "stateRevision": view.revision,
        },
        "messages": messages,
        "slashCommands": [],
        "todos": [],
        "todoGroups": [],
    }))
}
