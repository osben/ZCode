import type { OrderTrace } from "./causality-order.js";
import type { AnalysisCore, CoreSites } from "./core.js";
import type { TaintOcc } from "./domain.js";

/**
 * JSON encoding/decoding for `AnalysisCore`.
 *
 * Core is already pure data with no location dependencies; the only obstacle for `JSON.stringify`
 * is the `Map`s in `facts.*` and `types.*`, which serialize as `{}`. Replace each Map with an
 * **ordered** `[key, value][]`: the array preserves insertion order, and decoding restores it with
 * `new Map(entries)`. Thus `serializeCore(decode(encode(c)))` is byte-for-byte equal to
 * `serializeCore(c)`, and graphs projected from a frozen artifact match those at export time.
 *
 * `sites` and `trace` contain only plain objects, arrays, and optional fields, so pass them through
 * as-is: `JSON.stringify` drops properties with undefined values, and the decoder does **not** add
 * them back. Projections treat an absent field and a field set to undefined equivalently. The sole
 * exception is `joinPortTypes`: undefined in `(string | undefined)[]` serializes as `null` in JSON,
 * so encode it explicitly as `null` and convert it back to undefined on decode. This preserves an
 * “unknown port type” hole as undefined across the round trip rather than turning it into null.
 */

/** Ordered Map entries: array order is the Map's insertion order. */
export type MapEntries<V> = [string, V][];

export interface AnalysisCoreJson {
  /** Format version; the decoder throws on unknown versions rather than guessing. */
  version: 1;
  sites: CoreSites;
  facts: {
    askData: MapEntries<TaintOcc[]>;
    askActor: MapEntries<TaintOcc[]>;
    worldReadData: MapEntries<TaintOcc[]>;
    joinIn: MapEntries<TaintOcc[]>;
    fanoutIn: MapEntries<TaintOcc[]>;
    returnData: TaintOcc[];
  };
  trace: OrderTrace;
  types: {
    siteType: MapEntries<string>;
    /** Port-type holes (`undefined`) are represented as `null` here; JSON arrays have no undefined value. */
    joinPortTypes: MapEntries<(string | null)[]>;
  };
}

const VERSION = 1;

/** Convert core to a plain object that can be passed directly to `JSON.stringify`; `sites` and `trace` share their original references. */
export function encodeAnalysisCore(core: AnalysisCore): AnalysisCoreJson {
  return {
    facts: {
      askActor: [...core.facts.askActor],
      askData: [...core.facts.askData],
      fanoutIn: [...core.facts.fanoutIn],
      joinIn: [...core.facts.joinIn],
      returnData: core.facts.returnData,
      worldReadData: [...core.facts.worldReadData],
    },
    sites: core.sites,
    trace: core.trace,
    types: {
      joinPortTypes: [...core.types.joinPortTypes].map(([id, ports]) => [
        id,
        ports.map((port) => (port === undefined ? null : port)),
      ]),
      siteType: [...core.types.siteType],
    },
    version: VERSION,
  };
}

/** Reconstruct core from JSON (preserving Map insertion order). Unknown versions throw a regular `Error`. */
export function decodeAnalysisCore(json: AnalysisCoreJson): AnalysisCore {
  if (json.version !== VERSION) {
    throw new Error(`unsupported AnalysisCoreJson version ${String(json.version)} (expected ${VERSION})`);
  }
  return {
    facts: {
      askActor: new Map(json.facts.askActor),
      askData: new Map(json.facts.askData),
      fanoutIn: new Map(json.facts.fanoutIn),
      joinIn: new Map(json.facts.joinIn),
      returnData: json.facts.returnData,
      worldReadData: new Map(json.facts.worldReadData),
    },
    sites: json.sites,
    trace: json.trace,
    types: {
      joinPortTypes: new Map(
        json.types.joinPortTypes.map(([id, ports]) => [id, ports.map((port) => (port === null ? undefined : port))]),
      ),
      siteType: new Map(json.types.siteType),
    },
  };
}
