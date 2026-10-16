/** Error taxonomy of the ACP agent runtime. */
export type AcpRuntimeErrorCode =
  | "ACP_INVALID_LAUNCH"
  | "ACP_SPAWN_FAILED"
  | "ACP_HANDSHAKE_FAILED"
  | "ACP_PROTOCOL_VERSION"
  | "ACP_AGENT_DIED"
  | "ACP_TIMEOUT"
  | "ACP_CANCELLED"
  | "ACP_STATE";

export class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;

  constructor(code: AcpRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AcpLaunchValidationError extends AcpRuntimeError {
  constructor(message: string) {
    super("ACP_INVALID_LAUNCH", message);
  }
}

export class AcpSpawnError extends AcpRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("ACP_SPAWN_FAILED", message, options);
  }
}

export class AcpHandshakeError extends AcpRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("ACP_HANDSHAKE_FAILED", message, options);
  }
}

export class AcpProtocolVersionError extends AcpRuntimeError {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(
      "ACP_PROTOCOL_VERSION",
      `Agent negotiated protocol version ${actual}, runtime requires ${expected}`,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

export class AcpAgentDiedError extends AcpRuntimeError {
  constructor(message: string, options?: ErrorOptions) {
    super("ACP_AGENT_DIED", message, options);
  }
}

export class AcpTimeoutError extends AcpRuntimeError {
  constructor(message: string) {
    super("ACP_TIMEOUT", message);
  }
}

export class AcpCancelledError extends AcpRuntimeError {
  constructor(message: string) {
    super("ACP_CANCELLED", message);
  }
}

export class AcpStateError extends AcpRuntimeError {
  constructor(message: string) {
    super("ACP_STATE", message);
  }
}
