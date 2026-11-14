//! 子代理的上下文包装：system 段换成子代理的，两组当步 attachment 原样交给主线程的实现（修复线 F16）。

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId};
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_kernel_api::model::{QuerySource, SystemBlock};
use rust_cli_kernel_api::orchestration::{
    BuiltContext, ContextBuilder, ContextRequest, OrchestrationError,
};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::selection;
use serde_json::Value;

use super::SubagentContext;

/// `text` is the request's `inject_agents_md`, so a test sees what the wrapper passed on.
fn attachment(source: &str, request: &ContextRequest) -> AttachmentMessage {
    AttachmentMessage {
        id: MessageId::new(source),
        source: source.to_owned(),
        text: request.inject_agents_md.to_string(),
        data: Value::Null,
    }
}

/// 运行开始给 `environment`，工具轮结束给 `total_tokens_reminder`。
struct Inner;

#[async_trait]
impl ContextBuilder for Inner {
    async fn build(
        &self,
        request: ContextRequest,
        _history: &[Message],
    ) -> Result<BuiltContext, OrchestrationError> {
        Ok(BuiltContext {
            system: Vec::new(),
            attachments: vec![attachment("date", &request)],
        })
    }

    async fn turn_attachments(
        &self,
        request: ContextRequest,
        _history: &[Message],
    ) -> Result<Vec<AttachmentMessage>, OrchestrationError> {
        Ok(vec![attachment("total_tokens_reminder", &request)])
    }

    async fn start_attachments(
        &self,
        request: ContextRequest,
        _history: &[Message],
    ) -> Result<Vec<AttachmentMessage>, OrchestrationError> {
        Ok(vec![attachment("environment", &request)])
    }
}

fn request() -> ContextRequest {
    ContextRequest::new(
        SessionId::new("sess_subagent_agent_1"),
        WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/Users/dev/w"),
        },
        QuerySource::Subagent("general-purpose".to_owned()),
        PermissionMode::Default,
        selection(),
    )
}

/// 修 bug（F16）：包装没有转发 `start_attachments` 时落到缺省实现（`turn_attachments`），子代理
/// 第一个请求变成工具轮那一组的顺序（环境段在延迟工具之前）。
#[tokio::test]
async fn both_groups_and_the_announcements_come_from_the_inner_builder() {
    let context = SubagentContext {
        inner: Arc::new(Inner),
        inject_agents_md: true,
        system: vec![SystemBlock {
            text: "Agent prompt.".to_owned(),
            cache_control: None,
        }],
    };
    let start = context.start_attachments(request(), &[]).await.unwrap();
    assert_eq!(start[0].source, "environment");
    let turn = context.turn_attachments(request(), &[]).await.unwrap();
    assert_eq!(turn[0].source, "total_tokens_reminder");
    let built = context.build(request(), &[]).await.unwrap();
    assert_eq!(built.system[0].text, "Agent prompt.");
    assert_eq!(built.attachments[0].source, "date");
}

/// Fork (specs/fork-rust-subagent-runtime-config.md rule 15): the wrapper passes its definition's `injectAgentsMd` to
/// all three groups.
#[tokio::test]
async fn the_wrapper_passes_inject_agents_md_on() {
    for inject in [true, false] {
        let context = SubagentContext {
            inner: Arc::new(Inner),
            inject_agents_md: inject,
            system: Vec::new(),
        };
        let start = context.start_attachments(request(), &[]).await.unwrap();
        let turn = context.turn_attachments(request(), &[]).await.unwrap();
        let built = context.build(request(), &[]).await.unwrap();
        for found in [&start[0], &turn[0], &built.attachments[0]] {
            assert_eq!(found.text, inject.to_string());
        }
    }
}
