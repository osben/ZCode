//! Fork: specs/fork-rust-node-helper.md F3, `helper/sampleModel`.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::sampling::{
    SamplingBlock, SamplingError, SamplingReply, UNSUPPORTED_COMPLETION,
};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::codes;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{answer, parse};

#[test]
fn the_request_reads_the_part_node_forwards_to_the_model() {
    let params = json!({
        "requestKey": "helper-1",
        "sessionId": "s1",
        "source": {"pluginId": "viewer@inline", "serverName": "plugin:viewer:view", "appIdentity": "ui://v"},
        "request": {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": "Hi"}},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Look"},
                    {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="},
                ]},
            ],
            "systemPrompt": "Be brief.",
            "maxTokens": 300,
            "includeContext": "none",
            "modelPreferences": {"hints": [{"name": "other-model"}]},
        },
    });
    let call = parse(&params, CancellationToken::new()).unwrap();
    assert_eq!(call.session, SessionId::new("s1"));
    let request = call.request;
    assert_eq!(request.system_prompt.as_deref(), Some("Be brief."));
    assert_eq!(request.max_tokens, 300);
    assert!(!request.messages[0].assistant);
    assert_eq!(
        request.messages[0].content,
        vec![SamplingBlock::Text("Hi".to_owned())]
    );
    assert!(request.messages[1].assistant);
    assert_eq!(
        request.messages[1].content[1],
        SamplingBlock::Image {
            mime_type: "image/png".to_owned(),
            data: "iVBORw0KGgo=".to_owned()
        }
    );
}

#[test]
fn a_malformed_request_is_refused() {
    let base = json!({"sessionId": "s1", "request": {
        "messages": [{"role": "user", "content": {"type": "text", "text": "Hi"}}],
        "maxTokens": 10,
    }});
    assert!(parse(&base, CancellationToken::new()).is_ok());
    let broken = [
        ("/sessionId", json!(null)),
        ("/request/maxTokens", json!(0)),
        ("/request/messages", json!([])),
        ("/request/messages/0/role", json!("system")),
        ("/request/messages/0/content", json!([])),
        ("/request/messages/0/content/type", json!("audio")),
        ("/request/systemPrompt", json!(3)),
    ];
    for (pointer, value) in broken {
        let mut params = base.clone();
        match params.pointer_mut(pointer) {
            Some(slot) => *slot = value,
            None => {
                let (parent, key) = pointer.rsplit_once('/').unwrap();
                params.pointer_mut(parent).unwrap()[key] = value;
            }
        }
        let error = parse(&params, CancellationToken::new()).unwrap_err();
        assert_eq!(error.code, codes::INVALID_PARAMS, "{pointer}");
    }
}

#[test]
fn the_answer_is_nodes_sampling_result_or_its_error() {
    let reply = SamplingReply {
        model: "glm-5.3".to_owned(),
        text: "Hello".to_owned(),
        stop_reason: "endTurn".to_owned(),
    };
    assert_eq!(
        answer(Ok(reply)).unwrap(),
        json!({
            "role": "assistant",
            "model": "glm-5.3",
            "content": {"type": "text", "text": "Hello"},
            "stopReason": "endTurn",
        })
    );
    let failed = answer(Err(SamplingError::Failed(
        UNSUPPORTED_COMPLETION.to_owned(),
    )))
    .unwrap_err();
    assert_eq!(failed.message, UNSUPPORTED_COMPLETION);
    let missing = answer(Err(SamplingError::Kernel(KernelError::NotFound {
        session: SessionId::new("s1"),
    })))
    .unwrap_err();
    assert_eq!(missing.code, codes::INVALID_PARAMS);
}
