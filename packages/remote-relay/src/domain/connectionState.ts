export type ConnectionPhase = "new" | "registering" | "loading" | "challenge" | "authenticated";

export function permitsMessage(phase: ConnectionPhase, type: string): boolean {
  if (phase === "new") return type === "device_register_init" || type === "auth_init";
  if (phase === "challenge") return type === "auth_response";
  if (phase === "authenticated") return type === "pair_status_query" || type === "data";
  return false;
}
