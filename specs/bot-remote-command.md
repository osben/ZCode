# Bot `/remote` command: mint a web-remote control link (ZCO-7 V1)

A bound bot chat can ask the desktop for a web-remote control link with `/remote`. The desktop
mints (or reuses) a window remote-control runtime and replies with a tappable URL that opens the
existing web-remote UI served by the relay (`/remote/v4`). V1 is link-only; the QR image and the
Telegram Mini App (V2) are follow-ups. Linear: ZCO-7.

## Current state

- Bot commands live in `packages/services/src/bots/commandParser.ts` (parse) and `botsService.ts`
  (dispatch switch, `withAuthorizedContext` gate); menu order in `commandOrder.ts`; policy shape
  `BotAllowedCommands` in `packages/shared/src/bots.ts` (persisted in `bot-config.v3.json`,
  normalized by `normalizeBotCommandPolicy`).
- The bot service runs inside the local window host process and reaches desktop main via a
  parentPort bridge (`botRemoteWorkspaceBridge.ts`): typed request/result messages routed by
  `desktopHostProcess.ts` to handlers injected from `packages/desktop/src/main/index.ts`
  (`BotRemoteWorkspaceReconnect|ConnectionStatus|RuntimePort` are the three existing ones).
- Web remote control is window-scoped (`webRemoteControlManager.ts`): `start(windowId, context)`
  registers the persisted device identity on the relay, waits for QR-ready, and builds the URL via
  `buildWebRemoteControlExternalQrUrl` (`sid` + `hash` + `t`; `t` is informational — the web client
  does not validate it). A phone pairing URL stays valid while the runtime is alive and the pairing
  material (persisted `deviceSid`/`passHash`) is not reset; rotating it is the existing
  "refresh pairing" action.
- Workspace bridging from the phone validates the requested workspace against the runtime window's
  synced workspace list (`createWorkspaceBridge` → `getAvailableWorkspaces(runtime)`); the renderer
  pushes that list once a remote-control session is active (`useRootPlatformEffects.ts`).
- Main tracks local workspace paths per window (`windowWorkspaceMap`, fed by `syncWindowTabs`);
  remote (SSH) sessions are attached per window by `remoteSessionManager`.

## Command semantics

- `/remote` (aliases: `/远程`) mints a link for the workspace the conversation is currently bound
  to (the same workspace `/status` reports). No arguments in V1.
- Reply: a localized message with the bare URL. Telegram auto-links plain URLs, so no parse mode or
  HTML entity work is needed; other providers send it as plain text.
- Failures reply with a localized reason and never fall back to minting for a different workspace.

## Authorization model

- `/remote` is **private-chat only**. In a group the reply would be visible to every member, and
  the link is a bearer credential — so group requests are rejected outright with a localized
  message before any authorization or minting (cross-chat private delivery to the owner is not
  uniformly supported by providers; a private-delivery design is deferred with V2).
- In private chats the command goes through `withAuthorizedContext(message, "remote")`: bot
  enabled, user bound, workspace allowlist — identical to `/status` et al.
- Policy key `remote?: boolean` on `BotAllowedCommands`, default `true`, additive in
  `normalizeBotCommandPolicy` and `DEFAULT_BOT_COMMANDS`; old configs omit the key and get the
  default. UI toggle list in `BotsDialog` carries the same key.
- Default-on rationale: a bound chat can already drive the workspace (send prompts, approve
  permissions); the link grants the same control surface, not more. The real risk is URL
  forwarding (bearer credential), covered below.

## Link lifetime and revocation

- A minted URL is a bearer credential for the desktop's remote-control session. It remains usable
  while the runtime is running and until pairing material is rotated — the same security
  properties as the QR URL shown in the desktop UI. The bot reply includes a short localized
  warning that the link grants full control and should not be forwarded.
- Revocation in V1 is the existing desktop control: stopping remote control, or "refresh pairing"
  (rotates `deviceSid`/`passHash` and invalidates all previously minted URLs). No bot-side revoke
  subcommand in V1 (the bot chat cannot tell which runtime a link belongs to once minted; deferred
  with V2).
- `/remote` never restarts a live runtime (that would drop an active phone session): if a runtime
  already serving the workspace exists, the handler re-mints a fresh URL from that runtime's
  current pairing material.

## Mint flow (owner and event order)

```
Bot chat          botsService (host proc)      desktop main                     relay/phone
  |  /remote           |                           |                              |
  | -----------------> | withAuthorizedContext      |                              |
  |                   | parentPort: WebRemoteLinkRequest(win, ws, target?)       |
  |                   | -------------------------> | 1. reuse: runtime serving ws?|---> existing QR URL
  |                   |                            | 2. else start on a window    |---> register + QR-ready
  |                   |                            |    (local: windowWorkspaceMap|
  |                   |                            |     remote: bot window +     |
  |                   |                            |     reconnectBot session)    |
  |                   | <------------------------- | { ok, url, sessionId }       |
  |  reply w/ URL     |                            |                              |
  | <-----------------|                            |                        phone opens URL, pairs
```

Single owner: desktop main owns runtime lifecycle and URL minting; the bot only requests and
relays. Idempotency: repeated `/remote` reuses the live runtime and re-mints (same `sid`/`hash`,
fresh `t`).

Concurrency: the find-or-start operation is deduplicated per workspace key by an in-flight map in
the main handler — two simultaneous `/remote` requests (or a retry racing the first call) share one
promise instead of racing into two `manager.start` calls on the same window, where the second start
would stop and replace the transport the first just established.

Window selection rules (main-side handler):

1. **Reuse** — any live runtime whose window's synced workspace list covers the requested
   `workspaceKey` with a **bridgeable** target (`isBridgeableRemoteTarget`: a remote entry must
   carry `workspaceIdentity` + live `remoteSessionId`). Disconnected remote tabs kept in the list
   for display, and runtimes whose `remoteSessionId` was cleared by `failRemoteSession`, do NOT
   count — those fall through to rule 3 so the session is reconnected first. Re-mints the URL from
   that runtime without restarting it.
2. **Start, local workspace** — the window holding the workspace open (`windowWorkspaceMap`) →
   `webRemoteControlManager.start(windowId, context)`. The window's renderer then syncs its
   workspace list to the new runtime (existing status-driven effect).
3. **Start, remote (SSH) workspace** — ensure the session on the bot's window via
   `remoteSessionManager.reconnectBotRemoteWorkspaceSession` (idempotent when already attached),
   then start the runtime on that window with `{ workspacePath, workspaceIdentity, remoteSessionId }`.
4. **No window serves the workspace** — localized error telling the user to open the workspace on
   the desktop first.

The desktop feature gate (`webRemoteControlFeatureGate`) and relay reachability failures surface as
localized bot errors; the bridge request carries a 90 s timeout (relay QR-ready wait dominates).

## Protocol and persistence impact

- Additive parentPort pair in `packages/shared/src/validation.ts` + `channels.ts`:
  `BotRemoteWorkspaceWebRemoteLinkRequest` (requestId, workspacePath, workspaceIdentity, optional
  resolved `target` for remote workspaces) / `...Result` (ok, url?, sessionId?, error?). Routed in
  `desktopHostProcess.ts` to `handleBotRemoteWorkspaceWebRemoteLinkRequest` injected from
  `index.ts`.
- `BotCommand` union gains `{ type: "remote" }`; `BOT_POLICY_COMMAND_ORDER`, help map, Telegram
  `setMyCommands` maps, and i18n (`zh-CN` / `en-US` / `uk-UA`) gain `remote`.
- Manager gains one read-only method (`findLinkForWorkspace`) for the reuse path; `start` is reused
  as-is. No zcode-protocol v4 wire changes, no new persisted bot state, no SQL.

## Non-goals (V1)

- QR image in the chat (needs a QR renderer dependency in the bot host; deferred).
- Telegram Mini App / `initData` auth (V2).
- Bot-side link revocation, per-link TTLs, or link history.
- Minting for a workspace that is not open/attached in any desktop window (the phone could not
  bridge into it anyway).

## Acceptance scenarios

1. Private chat, local workspace open in the single desktop window, remote control idle →
   `/remote` starts the runtime and replies with a URL that pairs and shows the workspace.
2. Remote control already active for the same workspace → `/remote` replies quickly with a URL
   carrying the same `sid`/`hash`; the active phone session is not interrupted.
3. Remote (SSH) workspace bound and connected → `/remote` replies with a URL whose runtime bridges
   the remote session.
4. Workspace not open on the desktop → localized error, nothing started.
5. Group chat → localized private-chat-only reply before any authorization or minting; no runtime
   started. Unbound private chat, or `remote: false` in policy → existing localized denial replies;
   no runtime started.
6. Feature disabled or relay unreachable → localized failure reply; no partial runtime left behind.
7. Old `bot-config.v3.json` without `remote` key → command allowed (default), config round-trips
   without dropping other keys.
8. Two `/remote` requests racing for the same workspace → one start, both replies carry the same
   URL; no runtime is stopped and replaced mid-flight.
9. Runtime alive but its remote session was cleared (remote workspace dropped) → reuse is skipped,
   the handler reconnects the session and returns a working URL instead of a dead one.
