# CLI Headless CDP Browser Backend spec

> Status: implemented. Date: 2026-07-13.
> Parent specs: `2026-07-10-browser-use-codex-parity-spec.md`, `2026-07-13-node-repl-mcp-runtime-spec.md`.

## 1. Summary

The ZCode CLI on Linux servers must run ZCode's own Browser Use directly, without depending on the Desktop IAB, `agent-browser` or a GUI built-in browser. The CLI creates and manages a standalone Chromium through explicit arguments and exposes it as a real `cdp` backend discoverable by the existing browser-client:

```text
model
  -> mcp__node_repl__js
  -> browser-use plugin scripts/browser-client.mjs
  -> authenticated Node REPL browser broker
  -> BrowserControlPort
  -> managed CDP backend
  -> headless Chromium
```

`headless` is a launch/display mode of the `cdp` backend, not a new backend family. If the CLI later launches a headed Chromium the descriptor is still `type: "cdp"`; IAB, although it uses CDP internally, stays `type: "iab"` because its UI, ownership and lifecycle semantics differ.

## 2. Clarifications and fixed boundaries

| Question | User confirmation | Fixed boundary |
| --- | --- | --- |
| CLI self-launch or connect to an external CDP | recommended option | P0 is a CLI managed launch; attach-cdp later |
| Start by default? | recommended option | must be explicit `--browser-use=headless` |
| Browser profile | recommended option | a temporary profile per CLI process; no login state restored across processes |
| Entry points in effect | recommended option | `--prompt`, `--target` and TUI; the ZCode app-server is excluded |
| Browser distribution | recommended option | P0 downloads/bundles no browser; an explicit path wins, then installed Chromium |

## 3. CLI contract

New global arguments: `--browser-use=headless` and `--browser-executable=<absolute path>`. Example:

```bash
zcode --browser-use=headless \
  --browser-executable=/usr/bin/chromium \
  --prompt "打开 http://127.0.0.1:4173 并测试登录流程"
```

Rules:

- P0 `--browser-use` accepts only `headless`; unknown values fail at the CLI argument boundary.
- `--browser-executable` may only be used with `--browser-use=headless`.
- An explicit path must resolve to an absolute path and an executable file; on a bad path no App/session is created.
- Without an explicit path, the adapter looks for installed Chrome/Chromium per platform and for an existing Chromium in the Playwright cache; P0 does not download browsers.
- `--no-browser` keeps its OAuth login argument semantics and must not be reused as a Browser Use switch.
- `zcode app-server` / `zcode app-server --stdio` using this argument fails closed; no separate CLI browser runtime for the Desktop, Web Remote or mobile shared-host chains.
- No new environment variable; a later config-file entry must first define priority and source audit.

## 4. Descriptor and capabilities

A descriptor may be returned only after Chromium started and the CDP handshake completed:

```ts
{
  id: `cdp:${runtimeId}`,
  generation,
  type: "cdp",
  name: "ZCode Headless Chromium",
  capabilities: {
    browser: [{ id: "viewport", description: "..." }],
    tab: []
  },
  metadata: {
    provider: "zcode-cli",
    launchMode: "managed",
    headless: "true"
  }
}
```

`metadata` must not contain the executable path, temporary profile path, CDP endpoint, token, query or other sensitive values. On a launch failure, an unrecovered browser crash or an unfinished handshake, `list()` must not return a stub descriptor.

P0 supports and exposes in the object graph: browser discovery/default/URL selection; tabs list/get/new/selected/close; goto/back/forward/reload, url/title/state; DOM snapshot, Playwright locator/action/wait/evaluate; screenshot, viewport; CUA keyboard/mouse/scroll/drag; basic JavaScript dialog.

P0 must hide unfinished capabilities with `apiSupportOverrides`: user history/claim; visibility; handoff/deliverable/finalize; file chooser/upload, download/media; clipboard, dev logs, raw CDP/pageAssets/content. Exposing unimplemented members that return `NotImplemented` is not allowed.

## 5. Ownership, isolation and lifecycle

The state owner is the CLI adapter, not the Agent core, the MCP child, the relay or desktop main:

| State | Owner | Lifetime |
| --- | --- | --- |
| Chromium process | managed CDP adapter | the current CLI/TUI app runtime |
| BrowserContext | managed CDP adapter | one isolated context per ZCode session |
| target/tab registry | managed CDP adapter | `workspaceKey + sessionId` scope |
| request/cancel ledger | managed CDP adapter | request/turn, controlled by AbortSignal |
| Browser/Tab JS binding | Node REPL kernel | kernel generation; backend generation is checked separately |

Behavior:

- The first `list()` does launch + handshake; the backend is discoverable only after success.
- One TUI process may reuse the Chromium process, but different sessions use different BrowserContexts and tabs are not visible across them.
- Turn end cancels only that turn's pending requests; tabs stay until session/app close. `tab.close()` closes only the target tab.
- `closeSession()` closes that session's pages/context; when no context remains, the managed Chromium is closed.
- A browser crash/relaunch must increment `generation`; old Browser/Tab bindings return stale/unavailable.
- CLI process exit does not promise tab recovery; the temporary profile must be cleaned.
- P0 accepts no external CDP endpoint, so the adapter always owns and closes the Chromium it launched.

A CLI local session without `workspaceIdentity` keeps using the `workspacePath` fallback; this feature changes no Desktop/Web Remote workspace identity, clientMode or deliveryKind routing.

## 6. I/O, security and error contract

- Chromium launch, temporary directories and CDP sockets all live in the adapter; core depends only on `BrowserControlPort`.
- Use `child_process.spawn(executable, args)`, never composing commands through a shell.
- Default to native `--headless=new`; no `DISPLAY` or Xvfb required.
- No `--no-sandbox` by default; CI should use a non-root user. P0 offers no CLI argument to bypass the sandbox.
- CDP uses a Chromium auto-assigned loopback endpoint and binds no public address; the endpoint does not enter logs/metadata.
- Navigation keeps the http/https/about:blank allowlist, forbidding file/data/javascript and other about URLs.
- The adapter must propagate AbortSignal. A cancel after the action was sent whose result cannot be proven returns `sideEffect: "uncertain"`; a cancel while queued returns `cancelled/none`.
- Errors use stable classes: `backend_unavailable`, `navigation_blocked`, `timeout`, `cancelled`, `capability_unsupported`, `execution_error`. Underlying spawn/CDP errors keep the cause, but user messages must not leak the endpoint, profile path or sensitive page content.
- With the browser-use plugin disabled no browser broker is injected and no Chromium starts; the generic node_repl still works.

## 7. Packaging contract

- The default release path is still the standard Node.js CLI bundle; the headless adapter must be able to start system Chromium from that entry.
- The shared browser command runtime may depend on the pinned Playwright injected script, but not on `agent-browser`, and must not require users to start a separate test service.
- The ordinary Node bundle resolves the injected script from installed dependencies; SEA must embed the same pinned source as a read-only asset and never fetch it from the network at runtime.
- When the injected runtime asset is not found, the `cdp` backend is not discoverable and returns an actionable error; it must not degrade to a DOM selector implementation with different semantics.

## 8. State space and pruning

Main domains: permission/tool/MCP, architecture/process boundary, desktop lifecycle, CLI packaging.

| Candidate | Combination | Class | Reason |
| --- | --- | --- | --- |
| HCDP-001 | prompt + explicit headless + real Chromium | accepted | main Linux automation path |
| HCDP-002 | TUI multi-session + headless | accepted | high risk for context/tab isolation |
| HCDP-003 | app-server + headless | pruned/rejected | violates shared-host ownership |
| HCDP-004 | plugin disabled + headless | accepted | must fail closed and start no process |
| HCDP-005 | missing executable | accepted | no leftover process or fake descriptor |
| HCDP-006 | external attach CDP | pruned | P0 does not own an external browser lifecycle |
| HCDP-007 | persistent profile | pruned | P0 prefers CI repeatability |
| HCDP-008 | Linux x real CDP x no DISPLAY | accepted | user's target environment |
| HCDP-009 | macOS/Windows path resolution | accepted pairwise | cross-platform resolution; real-machine risk listed separately |
| HCDP-010 | mobile/web remote starting its own headless | pruned | keeps depending on the existing shared host |

## 9. Acceptance cases

| Case | Setup / action | Assertions | Evidence |
| --- | --- | --- | --- |
| HCDP-001 | explicit headless, first list | launches once; returns one real `cdp` descriptor | adapter integration + real Chrome |
| HCDP-002 | plugin disabled | no broker, no Chromium process, node_repl usable | bootstrap/CLI integration |
| HCDP-003 | executable missing/not executable | CLI fails explicitly; no session, no zombie, no descriptor | CLI unit + process probe |
| HCDP-004 | real model script calls Browser Use | MCP js -> browser-client -> broker -> port -> Chromium holds end to end | CLI E2E artifact |
| HCDP-005 | local HTTP fixture | navigate, DOM, locator, click/fill, screenshot correct | real Chromium E2E |
| HCDP-006 | no DISPLAY | native headless succeeds without launching Xvfb | Linux container E2E |
| HCDP-007 | turn end / session close | turn keeps tabs; close cleans context/process/temp profile | integration + process evidence |
| HCDP-008 | cancel/timeout | no late cross-request mixing; side-effect uncertainty correct | adapter unit/integration |
| HCDP-009 | browser crash/restart | generation increments; old binding stale | adapter integration |
| HCDP-010 | unsupported API | members hidden from object graph and docs | manifest contract |
| HCDP-011 | URL scheme | http/https/about:blank allowed, other schemes rejected | runtime unit + real smoke |
| HCDP-012 | Node bundle / SEA | injected asset resolvable, startup smoke succeeds | build contract + startup smoke |
| HCDP-013 | context/browser close never settles | every close has a deadline; a Browser failure does not block Execution/MCP; the CLI finally exits within bounds | adapter + session/CLI focused tests |

The real E2E must go through `mcp__node_repl__js` and the plugin browser-client; calling the adapter directly proves only the adapter, not ZCode Browser Use.

Local real-browser chain: `pnpm --dir apps/zcode-cli test:browser-headless`. Linux, non-root, no `DISPLAY`/Xvfb container acceptance: `pnpm --dir apps/zcode-cli test:browser-headless:linux`.

## 10. Non-goals

- Do not use or wrap `agent-browser`; do not add a `headless` backend family.
- P0 does not download, update or bundle Chromium.
- No persistent user profile, external CDP attach, extension or user-tab claim.
- No change to the Desktop IAB, mobile replayable or remote workspace shared-host business semantics.

## 11. Implementation and verification record

- CLI prompt, target and TUI hand the managed `BrowserControlPort` to the existing `createZCodeApp` by dependency injection; app-server rejects at the argument boundary.
- The adapter manages tabs, generation, cancel and close with one Chromium process + one BrowserContext per session; the snapshot ref keeps the ElementHandle in the adapter and does not expose it to page `globalThis`.
- Context, browser and late-launch cleanup all wait with bounds; one hanging Playwright close does not stop cleanup of other session resources, and a final CLI watchdog prevents an unknown handle from keeping the process alive forever.
- The ordinary Node bundle lazily resolves the pinned `playwright-core@1.59.1`; the SEA collector embeds 465 hashed assets of the same package and unpacks them after verifying in the user cache.
- Automation covers 12 adapter lifecycle/concurrency/cancel/timeout/generation/security cases, CLI argument and prompt/TUI wiring, core manifest capability hiding, and the SEA asset contract.
- A real macOS E2E with `DISPLAY` removed passed: MCP `js` -> browser-client -> authenticated broker -> BrowserControlPort -> headless Chromium, verifying DOM snapshot, locator fill/click, state reads and screenshot.
- The host SEA completed a real build, injection, ad-hoc sign and `--version` smoke. The Linux Docker harness is in place; the dev machine's Docker daemon was not running, so the Linux container run is left to CI/the server machine.
