/** Structured event sink. Events are fixed identifiers; no key material, tokens or user data are logged. */
export interface RelayLogger {
  info(event: string): void;
  warn(event: string): void;
  error(event: string): void;
}
