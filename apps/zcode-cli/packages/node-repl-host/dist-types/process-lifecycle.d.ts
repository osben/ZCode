/**
 * NodeReplSession handles synchronous errors from a REPL cell, but fire-and-forget
 * asynchronous errors (such as an unawaited tab.* call rejected when a turn is
 * interrupted) can terminate the entire server process under Node's default policy.
 * Once the child process dies, Browser Use is unavailable for the session. Downgrade
 * asynchronous errors to stderr logs to preserve runtime state without affecting protocol stdout.
 *
 * After the parent exits, stderr reports EPIPE. The old handler wrote the EPIPE stack
 * back to the same stderr, creating an infinite EPIPE -> uncaughtException -> stderr.write -> EPIPE
 * loop. A closed output pipe means the MCP client is unreachable, so shut down directly
 * instead of continuing to write diagnostics.
 */
export declare function installNodeReplProcessGuards(input: {
    onOutputClosed: (error: Error) => void;
    process: Pick<NodeJS.Process, "on">;
    writeStderr: (text: string) => void;
}): void;
export declare function installNodeReplShutdownTriggers(input: {
    process: Pick<NodeJS.Process, "once">;
    shutdown: () => void;
    stdin: Pick<NodeJS.ReadStream, "once">;
}): void;
export declare function isDirectMcpEntrypoint(importMetaUrl: string, argvPath: string | undefined): Promise<boolean>;
//# sourceMappingURL=process-lifecycle.d.ts.map
