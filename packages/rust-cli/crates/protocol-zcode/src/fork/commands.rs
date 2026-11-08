//! Fork: v4 command kinds beyond the upstream P1 set. `None` means the kind is not ported, and the
//! caller answers `proto.unsupportedCommand`.

use std::sync::Arc;

use rust_cli_protocol_core::sessions::Bridged;

use super::{queue, row_commands, session_config, session_delete};
use crate::inbox::{Ack, Envelope};
use crate::live::Live;
use crate::projection::state::Phase;
use crate::server::Server;

pub(crate) async fn decide(
    server: &Server,
    live: &Arc<Bridged<Live>>,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Option<Ack> {
    let _ = phase;
    Some(match envelope.kind.as_str() {
        "renameSession" => session_config::rename(live, envelope, revision).await,
        "switchModelConfig" => session_config::switch_model(live, envelope, revision).await,
        "switchCollaborationMode" => session_config::switch_mode(live, envelope, revision).await,
        "compact" => session_config::compact(live, envelope, revision).await,
        "editUserQuery" => row_commands::edit(server, live, envelope, revision).await,
        "retryTurn" => row_commands::retry(live, envelope, revision).await,
        "forkAssistant" => row_commands::fork(server, live, envelope, revision).await,
        "deleteSession" => session_delete::delete(server, live, envelope, revision).await,
        "deleteQueueItem" => queue::delete_queue_item(live, envelope, revision).await,
        "editQueueItem" => queue::edit_queue_item(live, envelope, revision).await,
        "reorderQueueItem" => queue::reorder_queue_item(live, envelope, revision).await,
        "setAutoDrain" => queue::set_auto_drain(live, envelope, revision).await,
        "sendQueuedNow" => queue::send_queued_now(live, envelope, revision).await,
        _ => return None,
    })
}
