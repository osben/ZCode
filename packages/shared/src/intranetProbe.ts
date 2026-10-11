export interface IntranetProbeTcpTarget {
  /** Unique target ID; defaults to host:port when omitted. */
  id?: string;
  kind?: "tcp";
  host: string;
  /** Defaults to 22 (SSH). */
  port?: number;
  /** Timeout for one probe; defaults to 800 ms. */
  timeoutMs?: number;
}

export interface IntranetProbeServiceTarget {
  /** Unique target ID; defaults to url when omitted. */
  id?: string;
  kind: "service";
  /** Internal-network probe service URL, for example, supplied by the caller through .env. */
  url: string;
  /** Expected marker in the service response (optional). */
  expectedMarker?: string;
  /** Optional simple token, sent in the x-zcode-intranet-token request header. */
  token?: string;
  /** Timeout for one probe; defaults to 800 ms. */
  timeoutMs?: number;
}

export type IntranetProbeTarget = IntranetProbeTcpTarget | IntranetProbeServiceTarget;

export interface IntranetProbeRequest {
  targets: IntranetProbeTarget[];
  /** Maximum retries per target; defaults to 2, range [1, 3]. */
  attempts?: number;
  /**
   * Number of targets that must be reachable to consider the client on the internal network.
   * Defaults to 1 (any reachable target is sufficient).
   */
  requiredSuccessCount?: number;
}

export interface IntranetProbeTcpTargetResult {
  targetId: string;
  kind: "tcp";
  host: string;
  port: number;
  reachable: boolean;
  /** Number of attempts made. */
  attemptCount: number;
  /** Latency in milliseconds when reachable; otherwise null. */
  latencyMs: number | null;
  /** Reason for the last failure. */
  error?: string;
}

export interface IntranetProbeServiceTargetResult {
  targetId: string;
  kind: "service";
  url: string;
  reachable: boolean;
  /** Number of attempts made. */
  attemptCount: number;
  /** Latency in milliseconds when reachable; otherwise null. */
  latencyMs: number | null;
  /** Marker returned by the service, if any. */
  marker?: string;
  /** Reason for the last failure. */
  error?: string;
}

export type IntranetProbeTargetResult =
  | IntranetProbeTcpTargetResult
  | IntranetProbeServiceTargetResult;

export interface IntranetProbeResult {
  /** Final internal-network determination. */
  isIntranet: boolean;
  /** Number of targets reached successfully. */
  reachedTargetCount: number;
  /** Determination threshold. */
  requiredSuccessCount: number;
  /** Total number of targets probed. */
  totalTargets: number;
  /** Timestamp in milliseconds. */
  checkedAt: number;
  /** Current probe strategy. */
  strategy: "tcp-connect" | "service-http" | "mixed";
  results: IntranetProbeTargetResult[];
}

export interface IntranetProbeServiceResponse {
  ok: boolean;
  marker?: string;
}
