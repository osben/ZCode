//! Fork: JSON-RPC methods beyond the upstream P1 set. `None` means the method is not ported, and the
//! caller answers `-32601`.

use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;

use crate::server::Server;

pub(crate) async fn dispatch(
    server: &Server,
    method: &str,
    params: Value,
) -> Option<Result<Reply, RpcError>> {
    let _ = (server, method, params);
    None
}
