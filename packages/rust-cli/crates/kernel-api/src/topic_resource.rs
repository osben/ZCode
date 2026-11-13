//! Fork: a bot-group topic's resources (specs/fork-rust-topic-resource.md). Node: `TopicResourcePort.read`
//! (`contracts/src/interfaces/session.port.ts`), implemented by the agent server over the reverse request
//! `topic/resource/read` (`bootstrap/src/zcode-protocol/topic-resource-port.ts`).
//!
//! The entry crate gives an implementation only where a Host serves the request (the app-server); without one the
//! `ReadTopicResource` tool is not registered.

use async_trait::async_trait;

/// One resource of the admitted topic snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicResourceRequest {
    /// The session (Node `taskId`).
    pub task: String,
    /// The admitting input's `sourceCommandId` (Node `inputId`).
    pub input: String,
    /// `botGroupSource.authorizationId` of that input.
    pub authorization: String,
    /// The resource's message in the resource index.
    pub message: String,
    /// The resource's position inside that message (Node `resourceIndex`).
    pub index: u64,
}

/// The Host's answer: the resource uploaded into the session as an attachment artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopicResource {
    /// `zcode-artifact://<session>/<artifact>`; the artifact holds `data:<mime>;base64,<payload>`.
    pub reference: String,
    pub file_name: String,
    pub mime: String,
    pub bytes: u64,
}

#[async_trait]
pub trait TopicResources: Send + Sync {
    /// Reads one resource through the Host. Dropping the future before it resolves cancels the read on the Host.
    /// The error is the text the tool reports.
    async fn read(&self, request: TopicResourceRequest) -> Result<TopicResource, String>;
}
