# CUA Target App Display Metadata Spec

## Target

The CUA tool card shows the actual target app icon, but the model does not need to (and is not guaranteed to) resubmit `bundle_id`. The official CUA runtime resolves the target app from the `state_id`, `frame_id`, `app_ref` or Helper response already verified for this call, then projects it to the ZCode UI through host-specific result metadata.

Only the display projection changes: the names and input schemas of the 30 CUA tools, model-visible results, permissions, side effects, owner/stale protection and delivery-state semantics are unchanged.

At release the ZCode catalog pin, official plugin wrapper, plugin manifest and official plugin definition must all align to `zcode-cua@0.5.8`, which contains this capability. Updating only the dependency SHA while keeping the old wrapper version would leave the dev bundle working while the official plugin cache path still lands on the old version; the version consistency check must block such a half upgrade.

`open_application(activate=false)` on a running app using the neutral shortcut must also complete the authoritative display identity through the Helper `application_info({pid})`; it must not fall back to the bundle id in model input just because the action was not re-dispatched.

## Authoritative resolution and trust boundary

```text
model input
  state_id / frame_id / app_ref(pid|bundle_id|name)
        |
        v
official zcode-cua invocation context
  session / frame registry / Helper application_info / capture result
        |
        v
MCP CallToolResult._meta["zcode.cua/target-app-display-v1"]
        |
        v
official CUA authority gate in Core
        |
        v
CuaToolResultDisplay.targetApp -> Desktop platform icon adapter
```

- The Renderer and Desktop main must not look up apps by PID. The PID belongs to the Helper/runtime that executes CUA and, in remote/shared-host scenarios, cannot be assumed to share a host or namespace with the UI process.
- Core accepts only MCP result metadata that passed official CUA authority verification. A same-named third-party server or tool gets no display capability.
- The `bundle_id` in model input is only a reference for the Helper to verify and never becomes the display identity directly.
- The first authoritative app identity obtained in one call locks the display context. Later settle observations may only supplement the same app; on identity conflict no target app is projected and the UI falls back to the generic CUA icon.

## Producer metadata contract

After the unified tool wrapper completes, `zcode-cua` attaches:

```ts
type CuaTargetAppDisplayMetaV1 = {
  schemaVersion: 1;
  displayName?: string;
  iconLocators: Array<
    | { kind: "darwin-bundle-id"; value: string }
    | { kind: "windows-executable-path"; value: string }
    | { kind: "windows-aumid"; value: string }
  >;
};
```

- `iconLocators` are in priority order, at most three. On identity conflict the first authoritative name may be kept but locators must be cleared so the UI uses the generic icon.
- macOS uses the bundle id captured by the Helper.
- Windows ordinary apps use the canonical absolute exe path. When the window has a valid AUMID, AUMID takes precedence; `ApplicationFrameHost.exe` must not be the icon locator after an AUMID failure.
- Linux produces no locator in this version.
- Global tools (access, list_apps cards, display, cursor, clipboard, wait, stop and full-screen screenshots with no app owner) produce no target metadata.
- When an app-scoped frame generates a child frame via `zoom`, it inherits the full app identity (name, PID, bundle id, AUMID and icon locator) and keeps projecting the same target metadata in this `zoom` result and later coordinate tools; a global frame with no app owner and its child frames stay target-less.
- `_meta` does not enter the provider-visible tool result; existing frame-integrity metadata is preserved.

## Core, persistence and UI

- `CuaToolResultDisplayPayload` keeps `schemaVersion: 1` and gains optional `targetApp: { displayName?: string; iconLocators: ApplicationIconLocator[] }`. Old records need no migration.
- The live `tool_call_result` and completed tool part metadata use the same bounded display; resume/cold hydration consumes the persisted field directly and does not parse model-visible text.
- Desktop continuous and Web Remote replayable reuse the same V4 row; relay/main add no task, queue, snapshot or recovery state.
- The CUA card takes the icon in the order structured `display.targetApp`, old input, old JSON result, generic CUA icon. No parsing of ordinary `app:` text lines is added.
- `IPlatformService.getApplicationIcon` accepts a structured locator request and keeps the string compatibility entry. macOS keeps resolving the bundle; Windows exe uses Electron `app.getFileIcon`; AUMID is read by Desktop through the Windows Shell `AppsFolder` identity.
- Web, mobile and Linux without a native resolver return `null` and show the generic icon.

## Failure and safety

- Locators pass a runtime schema. Darwin bundle, Windows AUMID and Windows absolute exe path are validated separately; a Windows exe is allowed only as a local fixed-drive absolute path, and UNC, device paths, relative paths and legacy strings never reach `app.getFileIcon`. Invalid, over-long or non-official sources are ignored.
- An icon read failure does not change the tool success state and feeds no error back to the model; Desktop logs only a bounded warn, and the same locator is cached to avoid high-frequency logging and repeated I/O.
- An async icon result must not write back after the component unmounts or the locator changed.

## Tests

- Producer: PID-only, state_id, frame_id, return_state=none, conflicts, concurrent isolation, global tools, zoom identity inheritance for app-scoped/global frames, coexistence with frame-integrity metadata, and unchanged model content.
- Core/contracts: official authority projection, third-party rejection, old and new display schemas, persistence/V4 round trip.
- UI/Desktop: structured metadata priority, legacy fallback, unmount safety, cache, locator validation, macOS bundle, Windows exe and AUMID adapter.
- Windows real-device smoke covers an ordinary Win32 app and the Calculator store app; macOS smoke covers Calculator. Windows native smoke that cannot run on the current host must be listed in the submission notes.

## 2026-09-17 revision: producer key change + node_repl consumption path

The `zcode.cua/target-app-display-v1` described above was replaced by the producer on 2026-08-20 (`zcode-cua@2796e8736 feat(cua): own application presentation metadata`) with `zcode.cua/app-associations-v1`:

```ts
type CuaAppAssociationsV1 = {
  schemaVersion: 1;
  /** Single-target action and observation (tools declared "primary" in APP_ASSOCIATION_MODE_BY_TOOL). */
  primary?: { appKey: string; displayName?: string; icon?: { mimeType: "image/png"; data: string } };
  /** list_apps (declared "items"): associated by result index, up to 128 entries. */
  items?: Array<{ resultIndex: number; application: /* same as primary */ unknown }>;
};
```

- `appKey` replaces `iconLocators`, in the forms `darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<canonical path>` / `linux-exe:<path>`; the consumer derives the locator by prefix.
- The producer now carries the Helper-captured PNG of at most 32x32 itself. ZCode does not project this `icon`: the convention that the session protocol carries no data URL is unchanged, and the icon is still resolved through `IPlatformService.getApplicationIcon(locator)`.
- ZCode never implemented consumption of `target-app-display-v1`; `CuaToolResultDisplay.targetApp` and `iconLocators` could not get values since 2026-08-20, and the tool card icon has relied on the legacy `readBundleId(input) ?? readCuaResultBundleId(result)` fallback, which is kept only for historical sessions.

After Computer Use moved to `node_repl`, the hop "official CUA authority gate in Core" no longer holds (the tool name is always `mcp__node_repl__js` and `readCuaToolName` does not match). The new chain moves the trust point to the host:

```text
producer _meta["zcode.cua/app-associations-v1"].primary
      |
      v  broker response, invisible to the sandbox
node-repl-host CUA bridge (the only trusted recording point)
      |
      v  NodeReplRunResult.cuaApp
node_repl result _meta["zcode/nodeReplCuaApp"] (written exclusively by the host)
      |
      v
Core `node_repl_images.app` -> UI leading icon
```

- `zcode.cua/app-associations-v1` arriving through sandbox-writable channels (`nodeRepl.setResponseMeta`, `nodeRepl.emitStructuredResult`) is always dropped: these two APIs hang on model-visible globals, and otherwise the model could make the tool card claim it operated another app. The handling matches `zcode/nodeReplBrowserScreenshotContentIndices`.
- The identity of the `node_repl` server is generated by the host and merged last (`resolveAppRuntimeConfig` keeps the built-in identity); users and third parties cannot hijack it with a same-named configuration, so Core consuming the host key by that server name is safe.
- The full projection and display contract are in "node_repl-era identity source" of [`cua-tool-app-identity-summary.md`](cua-tool-app-identity-summary.md).
