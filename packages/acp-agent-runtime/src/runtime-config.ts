/**
 * Session configuration snapshot of one runtime (specs/acp-agent-runtime.md "S6").
 *
 * The snapshot comes from the `session/new` or `session/load` response, then follows
 * `config_option_update`, `current_mode_update` and the `session/set_config_option` response. Only
 * select options are kept. An agent without `configOptions` gets a `mode` select synthesized from its
 * legacy `modes`, which is set with `session/set_mode` instead.
 */
import {
  methods,
  type ClientConnection,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AcpInvalidConfigError, AcpStateError } from "./errors.js";
import { withTimeout } from "./runtime-helpers.js";
import { mapSessionUpdate } from "./updates.js";
import type { AcpConfigOption, AcpConfigSelectOption, AcpRuntimeEvent } from "./types.js";

/** The configuration part of a `session/new` or `session/load` response. */
export interface AcpSessionConfigSource {
  readonly configOptions?: readonly SessionConfigOption[] | null;
  readonly modes?: SessionModeState | null;
}

/** One `setConfigOption` call of a ready runtime. */
export interface AcpConfigChange {
  readonly connection: ClientConnection;
  readonly sessionId: string;
  readonly configId: string;
  readonly value: string;
  readonly timeoutMs: number;
  /** Races the request against the owning process's spawn and stream failures. */
  readonly race: <T>(operation: Promise<T>) => Promise<T>;
  /** False once the process generation or the session changed during the request. */
  readonly isCurrent: () => boolean;
}

const SYNTHESIZED_MODE_ID = "mode";

export class AcpConfigState {
  #options: readonly AcpConfigOption[] = [];
  /** True while the snapshot is the `mode` select synthesized from legacy `modes`. */
  #synthesizedMode = false;

  get options(): readonly AcpConfigOption[] {
    return this.#options;
  }

  /** Replaces the snapshot from a handshake response; `configOptions` wins over `modes`. */
  reset(source: AcpSessionConfigSource): void {
    const normalized = normalizeConfigOptions(source.configOptions);
    if (normalized.length > 0 || !source.modes) {
      this.#options = normalized;
      this.#synthesizedMode = false;
      return;
    }
    this.#options = [synthesizeModeOption(source.modes)];
    this.#synthesizedMode = true;
  }

  /**
   * Sends one choice and returns the new snapshot. A synthesized legacy `mode` is set with
   * `session/set_mode`, any other option with `session/set_config_option` (whose response replaces
   * the snapshot). Throws `AcpInvalidConfigError` before any request when the id or the value is not
   * offered, and `AcpStateError` when the session changed during the request. Agent errors and the
   * `AcpTimeoutError` of the request propagate as they are.
   */
  async set(change: AcpConfigChange): Promise<readonly AcpConfigOption[]> {
    const { connection, sessionId, configId, value } = change;
    const option = this.#options.find((candidate) => candidate.id === configId);
    if (!option) throw new AcpInvalidConfigError(`Unknown config option "${configId}"`);
    if (!option.options.some((candidate) => candidate.value === value)) {
      throw new AcpInvalidConfigError(`Config option "${configId}" does not offer "${value}"`);
    }
    const legacyMode = this.#synthesizedMode && configId === SYNTHESIZED_MODE_ID;
    const request = legacyMode
      ? connection.agent
          .request(methods.agent.session.setMode, { sessionId, modeId: value })
          .then(() => undefined)
      : connection.agent
          .request(methods.agent.session.setConfigOption, { sessionId, configId, value })
          .then((response) => response.configOptions as unknown);
    const label = legacyMode ? "session/set_mode" : "session/set_config_option";
    const configOptions = await change.race(withTimeout(request, change.timeoutMs, label));
    // A restart during the request committed a fresh snapshot that this response must not overwrite.
    if (!change.isCurrent()) {
      throw new AcpStateError("ACP session changed while setting a config option");
    }
    if (Array.isArray(configOptions)) this.replace(configOptions as readonly SessionConfigOption[]);
    else this.setCurrentValue((candidate) => candidate.id === configId, value);
    return this.#options;
  }

  /**
   * Maps one `session/update` of the current session. Config updates change the snapshot and surface
   * it as `config_options` (a mode update without a mode option is ignored); any other update keeps
   * the `mapSessionUpdate` mapping.
   */
  surfaceUpdate(update: SessionUpdate): AcpRuntimeEvent | null {
    if (update.sessionUpdate === "config_option_update") {
      this.replace(update.configOptions);
    } else if (update.sessionUpdate === "current_mode_update") {
      if (!this.setCurrentValue(isModeOption, update.currentModeId)) return null;
    } else {
      return mapSessionUpdate(update);
    }
    return { type: "config_options", options: this.#options };
  }

  private replace(configOptions: readonly SessionConfigOption[]): void {
    this.#options = normalizeConfigOptions(configOptions);
    this.#synthesizedMode = false;
  }

  private setCurrentValue(match: (option: AcpConfigOption) => boolean, value: string): boolean {
    const index = this.#options.findIndex(match);
    if (index < 0) return false;
    this.#options = this.#options.map((option, position) =>
      position === index ? { ...option, currentValue: value } : option,
    );
    return true;
  }
}

function isModeOption(option: AcpConfigOption): boolean {
  return option.category === "mode" || option.id === SYNTHESIZED_MODE_ID;
}

/** Keeps the well-formed select options; boolean and malformed options are dropped. */
export function normalizeConfigOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): readonly AcpConfigOption[] {
  if (!Array.isArray(configOptions)) return [];
  const normalized: AcpConfigOption[] = [];
  for (const option of configOptions as readonly unknown[]) {
    const select = normalizeSelect(option);
    if (select) normalized.push(select);
  }
  return normalized;
}

function normalizeSelect(raw: unknown): AcpConfigOption | null {
  if (!isRecord(raw) || raw.type !== "select") return null;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return null;
  if (typeof raw.currentValue !== "string" || !Array.isArray(raw.options)) return null;
  const options: AcpConfigSelectOption[] = [];
  for (const entry of raw.options as readonly unknown[]) {
    if (isRecord(entry) && Array.isArray(entry.options)) {
      const group = typeof entry.name === "string" ? entry.name : null;
      for (const grouped of entry.options as readonly unknown[]) {
        const value = normalizeValue(grouped, group);
        if (value) options.push(value);
      }
      continue;
    }
    const value = normalizeValue(entry, null);
    if (value) options.push(value);
  }
  return {
    id: raw.id,
    name: raw.name,
    description: optionalString(raw.description),
    category: optionalString(raw.category),
    currentValue: raw.currentValue,
    options,
  };
}

function normalizeValue(raw: unknown, group: string | null): AcpConfigSelectOption | null {
  if (!isRecord(raw) || typeof raw.value !== "string" || typeof raw.name !== "string") return null;
  return { value: raw.value, name: raw.name, description: optionalString(raw.description), group };
}

function synthesizeModeOption(modes: SessionModeState): AcpConfigOption {
  const available = Array.isArray(modes.availableModes) ? modes.availableModes : [];
  return {
    id: SYNTHESIZED_MODE_ID,
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: modes.currentModeId,
    options: available.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: optionalString(mode.description),
      group: null,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
