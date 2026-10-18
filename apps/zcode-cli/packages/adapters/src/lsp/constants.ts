// Named constants for the language server pool (spec: apps/zcode-cli/docs/design/v2/tool/19-lsp.md §4-§5).

export const LSP_LOGGER_MODULE = "adapters.lsp";
export const LSP_CLIENT_NAME = "zcode";
export const LSP_JSON_RPC_VERSION = "2.0";
export const LSP_POSITION_ENCODING = "utf-16";

export const LSP_DEFAULT_IDLE_SHUTDOWN_MS = 600_000;
export const LSP_DEFAULT_MAX_RUNNING_SERVERS = 4;
export const LSP_DEFAULT_NOT_INSTALLED_RETRY_MS = 30_000;

/** Last bytes of server stderr kept for start-failure messages. Never logged in full. */
export const LSP_STDERR_TAIL_MAX_CHARS = 2_048;
/** Raw JSON-RPC payloads in debug logs are truncated to this length. */
export const LSP_LOG_PAYLOAD_MAX_CHARS = 500;

export const LSP_HEADER_SEPARATOR = "\r\n\r\n";
export const LSP_CONTENT_LENGTH_HEADER = "content-length";
/** Headers larger than this without a terminator mean the peer is not speaking LSP. */
export const LSP_FRAME_HEADER_MAX_BYTES = 8_192;

export const LSP_JSON_RPC_METHOD_NOT_FOUND = -32601;
export const LSP_JSON_RPC_INTERNAL_ERROR = -32603;
/** LSP RequestCancelled: the server aborted a request we cancelled with `$/cancelRequest`. */
export const LSP_JSON_RPC_REQUEST_CANCELLED = -32800;

export const LSP_METHOD_INITIALIZE = "initialize";
export const LSP_METHOD_INITIALIZED = "initialized";
export const LSP_METHOD_SHUTDOWN = "shutdown";
export const LSP_METHOD_EXIT = "exit";
export const LSP_METHOD_CANCEL_REQUEST = "$/cancelRequest";
export const LSP_METHOD_CONFIGURATION = "workspace/configuration";
export const LSP_METHOD_DID_CHANGE_CONFIGURATION = "workspace/didChangeConfiguration";
export const LSP_METHOD_REGISTER_CAPABILITY = "client/registerCapability";
export const LSP_METHOD_UNREGISTER_CAPABILITY = "client/unregisterCapability";
export const LSP_METHOD_WORK_DONE_PROGRESS_CREATE = "window/workDoneProgress/create";
export const LSP_METHOD_WORKSPACE_FOLDERS = "workspace/workspaceFolders";
export const LSP_METHOD_PULL_DIAGNOSTICS = "textDocument/diagnostic";
export const LSP_METHOD_LOG_MESSAGE = "window/logMessage";
export const LSP_METHOD_PROGRESS = "$/progress";

/** Shown in lifecycle events so that a fallback path from a failed start is distinguishable. */
export const LSP_STOP_REASON_SERVER_STOPPED = "language server stopped";
