# Plugin management lifecycle case catalog

This catalog defines the user-level lifecycle contract for Desktop local plugin management. A case counts as covered only when it has its own setup, action, assertion, and evidence; merely passing through a state on some longer path is not coverage.

## Scope and state ownership

- Included: Desktop local workspace, user-scope plugin storage, Public/Personal, Builtin, CDN, Personal Source, inline display, restart recovery, representative runtime injection, and key recoverable failures.
- Excluded: standalone Web, mobile `/remote`, remote workspace plugin sync, workspace-scope installs, formal CI that depends on the public network, and full locale/theme/viewport cartesian products.
- Install, config, enabled, source, and suppression state persist in `<E2E_HOME>/.zcode/cli/plugins` and the CLI config; the UI store is a projection, not the authority.
- Desktop local workspaces A/B share one E2E HOME, verifying current user-scope semantics.

```text
UI entry
  | Settings > Plugins
  v
pluginManagementStore
  | typed plugin service
  v
ZCode Agent plugin handlers
  |                     |
  v                     v
user plugin storage     future session runtime discovery
(source/install/config) (Skill + MCP evidence)
```

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `manual-review` | Automation implemented; awaiting manual confirmation of screenshots and product behavior |
| `formal` | Promoted to the default stable E2E after manual confirmation |
| `bug-candidate` | Current product gap; not written as a green expectation and not fixed inside test tasks |
| `pruned` | Explicitly not done; pruning reason kept |

## Accepted cases

| Case | Setup | Action | Assertions | Evidence | Initial status |
| --- | --- | --- | --- | --- | --- |
| `PLM-LC-001 discovery-navigation` | Isolated HOME; deterministic directories for Public, Community, and Personal | Enter Plugins from Settings; switch sections; search/clear within the current section; verify groups default expanded, collapse/expand manually; enter details via Card and in-marketplace Manage and return | Public by default; public categories and personal marketplaces fully expanded by default, manual collapse works; search scoped to the current source; clearing restores; returning preserves segment/query/scroll; marketplace ↔ management round-trips reachable | DOM + URL-free UI state + screenshot | `manual-review` |
| `PLM-LC-002 presentation` | Two groups: zh-CN/Zai Light/wide and en-US/Zai Dark/narrow | Open list, details, Manage, and source dialogs | Core actions visible and operable; no horizontal overflow; long copy does not cover controls | DOM layout + a11y role + screenshot | `manual-review` |
| `PLM-LC-003 personal-main-lifecycle` | Local-directory Personal Source, composite plugin v1 | Add source in UI, find plugin, open details, click Example Prompt twice, configure, toggle across entries, check updates, upgrade to v2, uninstall cancel/confirm | Five component classes visible; first click only installs; second only creates a draft without sending; config/enabled correct; after checking updates the installed row shows an “updatable” badge with an inline update entry; v2 takes effect; cancel changes nothing; confirm cleans up | UI + overview/list + storage + provider capture | `manual-review` |
| `PLM-LC-004 persistence-local-visibility` | v1 installed, configured, and disabled | Restart the app; switch local workspace A→B | source/install/config/disabled survive restart; B sees the same user-scope state | UI + persisted JSON + workspace switch | `manual-review` |
| `PLM-LC-005 source-orphan-reassociate` | Personal plugin installed | Delete the source; use/configure/toggle; re-add the same source | Install retained and marked source-missing; menu, details, badge, and inline update entry hidden; functionality still works; re-adding restores listing/update linkage | UI + installed/config files + runtime marker | `manual-review` |
| `PLM-LC-006 builtin-suppress-restore` | Isolated HOME; a Builtin enabled with config/data | Uninstall; stay on the detail page; restart; restore from Public | Config/user data cleaned; Catalog and the immutable builtin cache retained; runtime still not loaded after restart; detail component list readable; shows Restorable Builtin; restores to a clean default state | UI + suppression/config/data/cache/manifest files | `manual-review` |
| `PLM-LC-007 public-cdn-local` | Local HTTP ZIP as a deterministic official CDN fixture | Browse Public, details, install | Uses the unique official marketplace id; ZIP verified install; cached source and version correct | UI + HTTP fixture log + cache + overview | `manual-review` |
| `PLM-LC-007b official-cdn-smoke` | Manual environment with public network allowed | Refresh the real official CDN and install a designated smoke plugin | Real manifest/zip paths work | UI + network artifact | `manual-review`, never formal CI |
| `PLM-LC-008 recoverable-failures` | Fixture switchable between invalid/404/malformed/v1/v2 | Add an invalid source / official id conflict; fail refresh/describe/install/update and retry; cancel the uninstall confirmation | Errors visible; retry reachable; failures do not corrupt the old version, update badge, config, or installs; cancel has zero side effects | UI error + fixture request log + storage snapshot | `manual-review` |
| `PLM-LC-009 inline-smoke` | Isolated HOME with an inline plugin | View from Personal, details, Manage and use in a new session | Inline visible, components usable; the generic uninstall entry is not exercised | UI + runtime marker | `manual-review` |
| `PLM-LC-010 secret-env-agent-projection` | Personal plugin with an `${E2E_PLUGIN_RUNTIME_SECRET}` MCP env and an agent | After install, call the MCP in a new session; open Settings > Subagents | MCP returns only a resolved-secret marker without echoing the secret; the same agent file shows a single canonical-name row, the bare name still works as a runtime alias | provider capture + Subagents DOM + screenshots + Electron `capturePage()` video | `manual-review` |
| `PLM-LC-011 no-git-github-archive` | Real Anthropic Claude Marketplace; the Agent's Git binary points to a nonexistent path; adapter has a loopback fixture | Probe the non-GitHub Git fallback first; refresh `claude-plugins-official` via Renderer → Host → Agent Protocol and install the real `aikido` plugin | Fallback returns `plugin_git_unavailable`; the real marketplace/plugin HTTP Archive install succeeds; cache has no `.git` and is discoverable | diagnostics + captured HTTP records + installed/cache snapshot | `manual-review`, never formal CI |
| `PLM-LC-012 isolated-refresh-atomic-cache` | Two marketplaces with v1 snapshots; fixture A=v2, B=failure; cache copy/rename failure injectable | Batch refresh; restart; recover B; inject an activation failure during plugin update and retry | A updates; B keeps v1 with failure state surviving restart; B's failure clears on success; activation failure always keeps the old cache/install record, retry atomically switches to v2 | diagnostics + persisted JSON + directory snapshots | `manual-review` |
| `PLM-LC-013 suggested-prompt-official-install` | New Task suggestion references a missing plugin; official catalog fixture switchable success/failure/timeout | Click the suggestion; refresh `zcode-plugins-official`; confirm the User-scope install in the popover; switch to another suggestion mid-install | After the first local check finds it missing, a single popover first shows loading, then switches to install confirmation once resolution and Composer stabilize; prompt prefilled once and not sent; refresh aborts and fails closed at 10000 ms, failure/timeout rejects stale snapshots; success installs only the official candidate; switching cancels the old operation and late results are dropped; after completion the same popover keeps the chip leading with body retained | protocol/focused tests + UI manual review + user storage snapshot | `manual-review` |
| `PLM-LC-014 builtin-uninstall-detail-parity` | Isolated HOME; builtin plugin seeded, enabled, with config/data | Open details; uninstall; retry on the detail page; restart; click Install | `installed=false`; suppression exists; runtime provides no Skill/Command/MCP; Catalog/cache/full component details still readable; describe does not change config/data/cache; Install restores without creating a normal installed record | UI + protocol + config/data/cache/manifest + fresh discovery | `manual-review` |
| `PLM-LC-015 bundled-install-ownership` | A suppressed builtin plus a merged official entry; a same-name CDN source fixture | UI Install and direct protocol install separately | The bundled `filesystem/sea` path restores equivalently; the CDN source still installs via the marketplace; no stale suppression, duplicate ownership, or wrong installed records | protocol + installed record + runtime | `manual-review` |
| `PLM-LC-016 seed-cache-runtime-separation` | Suppressed builtins with cache present/missing; filesystem and SEA seed fixtures | resolve/list/describe/skills/commands; trigger cache self-healing | Suppression always filters runtime; a missing cache is restored from seed; describe succeeds before and after; Catalog is not filtered; no seed↔uninstall mutual-deletion oscillation | bootstrap + adapter + services tests | `manual-review` |
| `PLM-LC-017 installed-menu-layout` | A builtin explicitly enabled in the workspace `.zcode/config.json` (enabledSource=workspace) | Settings > Plugins, switch to Workspace scope; open the installed row's inline “…” menu | The menu has only Enable/Pause and Uninstall, two single-line equal-height items sized to content; restore-inherit and update are not in the menu | menuitem text Range box counting + screenshot | `manual-review` |
| `PLM-LC-018 official-auto-refresh-throttled` | Isolated HOME; official catalog has entries refreshed one minute ago | Enter, exit, re-enter the store | No refresh; the Claude catalog's time and failure state unchanged; previous candidates still visible | DOM + overview + throttle unit test | `manual-review` |
| `PLM-LC-019 official-auto-refresh-on-enter` | Isolated HOME; official catalog entries stale; real CDN allowed | Enter the store without clicking refresh, then exit and re-enter | Official time updates with no failure diagnostics; re-entering does not refresh again | DOM + overview + runtime logs | `manual-review`, never formal CI |
| `PLM-LC-020 plugin-subagent-override-cold` | Isolated HOME; the official judge's structured override sets alternate/high while the primary selection is primary/max | After a full restart, send and call document-skills:judge via the Agent | The child request is alternate/high, the parent continuation primary/max; the Agent completes normally; the saved override unchanged | case-local replay + actual requests + UI + state | `manual-review` |

Todo103 migration note: PLM-LC-018/019 came from the pinned staging commit `dbb3ec0ce8` and keep their pending identity. Throttling after first/stale/failed states and manual-refresh time priority are covered by shared criterion unit tests; real-CDN environment failures must be recorded separately from merge regressions, and public-network cases are never promoted to offline CI.

PLM-LC-020 closes the cold-start execution loop for source-plugin overrides; SE-04 already proved the UI save and plugin files unchanged, so this case directly constructs an isolated persistence input of the same format instead of repeating the full setup interaction. Child and parent requests use different models and reasoning levels; wrong inheritance must not pass. Local new execution only — not extended to hot updates or the remote-control matrix.

The PLM-LC-019 environment restriction stays: manual public-network checks use explicit replay fixtures and a manual-review hold, because capture MITM certificates break the Agent's marketplace fetch. That precondition failure only blocks public-network cases and is neither a product regression nor a blocker for other offline cases.

## Runtime closure for PLM-LC-003/005/009/010

- The detail UI must list all five groups — MCP, Skill, Command, Agent/Subagent, Hook — but only Skill and MCP close the runtime loop, representing the two distinct paths of discovery injection and tool registration.
- Runtime assertions must create a new session; existing pre-upgrade sessions are not required to hot-swap.
- The first Example Prompt click (not installed) may only install and must not create a session; the second click creates a new prefilled draft, and provider capture must be zero before sending.
- The env-var loop asserts only that MCP returns the “resolved” marker without the secret; screenshots, provider capture, logs, and error text must never record the secret value.
- A plugin agent's canonical runtime name and its unique bare name can coexist, but the settings page and plugin details show only the canonical name row per resource identity.

## Pruned combinations

| Dimension | Decision | Reason |
| --- | --- | --- |
| Client | Desktop local only | Web/remote attachment, workspace identity, and replayable boundaries belong to separate suites |
| Source × lifecycle | Personal Source runs the full main chain; Builtin/CDN/inline run only differential paths | Avoid repeating the same install/toggle/uninstall contract |
| Entry × operation | Representative operation per Card/Detail/Manage | No entry × operation cartesian product |
| Locale × theme × viewport | Two pairwise groups | Separate behavior from presentation contracts; control CI cost |
| Component runtime | Skill + MCP closure; the other three classes verify detail enumeration only | Two distinct runtime integration boundaries already covered |
| Network | Formal CI uses loopback fixtures only | Public network is unstable and unreproducible |
| Install scope | Current user scope only | The UI has no workspace-scope selector |

## Bug candidates

| ID | Gap | Test treatment |
| --- | --- | --- |
| `PLM-BC-001` | No cancel UI for store installs in Settings | Not claimed as covered; the separate cancel entry for suggested prompts is covered by PLM-LC-013 |
| `PLM-BC-002` | Source management has no standalone Validate/Diagnose | Covers add-time validation, update, and remove |
| `PLM-BC-003` | The inline generic menu exposes uninstall with no backend semantics | The smoke does not click uninstall, keeping the formal suite green |

## Promotion gate

All new specs start in `packages/desktop/test/e2e/plugins/manual-review/pending/`. After manual review of screenshots, interactions, and evidence, run the promotion dry-run first, then apply; unreviewed pending specs never enter default WDIO, Docker presets, or formal macOS/Windows CI.

## PLM-STRIP-CLIP (2026-09-15)

Accepted: 12 installed updatable plugins at 390/1200px, zh/en, light/dark — badges fully visible; hovering and keyboard-focusing the first/last items, scrolling horizontally to the end, then clicking a badge triggers only that update without opening details. No page horizontal overflow, no icon-strip vertical scrolling. Uses the real shared components and test action callbacks; the install backend is not overridden.

## 2026-09-16 confirmed cases

PLM-LC-018 (management list localization), PLM-LC-019 (dual-entry plugin creation draft), and PLM-LC-020 (add-marketplace navigation) are confirmed by the product plan; states, actions, assertions, and boundaries are in [plugin-creator](plugin-creator.md). Skill recording and marketplace fuzzy search are not covered.

## PLM-MISSING-CONFIG (2026-09-17)

Confirmed scenario: an old document-skills config exists with packageStatus=missing, and none of the three catalog/install/restore sets contain that id; five new plugins still have catalog entries. Enter the store and search the old name: neither the old card nor its install button appears, while new plugins stay visible. Contrast: a package the catalog still lists as repairable but missing locally keeps its install entry. The original plugins diagnostic set is not modified. Evidence: buildStoreItems regression + browser fixture (desktop/narrow, zh/en, light/dark) + a live check against the current dev user config. No automatic migration or config deletion; installed orphans, builtin restore, and Workspace/User config attribution are unchanged.

## PLM-DOCUMENT-ORDER (2026-09-17)

Default official document plugins sort PDF, PPT, Excel, Word. Browser cases cover the store category and the installed icon strip across desktop/mobile × zh/en × light/dark; preset management grouping, disabling, missing entries, same-name personal isolation, and server-side sort priority are covered by unit tests.
Entry: `packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`.
This case is browser presentation verification only — not evidence for Electron install lifecycle or formal CI admission.

### PLM-UI-001 UI marketplace and project config

- Isolated HOME, real catalog/install/config services, and an MCP fixture providing `ui://` resources. Install first, then start a formal session with plugin capabilities.
- Verify public/community/personal mutual exclusion, the UI section, detail image zoom and close, and in-marketplace manage/back preserving query and scope. The UI section shows all by default and supports in-place 8→6→8 card switching; other categories stay visible; search clearing and section round-trips preserve each section's manual selection. The main area and side pane share the same interactions.
- Pausing project A does not affect project B or the global scope; after restore-inherit, the global state applies. Installed UI opens; while paused, enable first — on failure it does not open; multiple surfaces require selection; closing the panel does not uninstall.
- The installed UI card's separate “Details” entry views info and config without enabling or opening the plugin; the main market's primary navigation returns to existing chats. Global-settings ↔ market sync, remote-sync notifications, background error retention, and slow views not blocking submission are supplemented by real store/hook regressions; removing the source package verifies install failure, then restore and retry.
- Browser layer adds zh/en, Zai Light/Dark, desktop and narrow panels, and keyboard; mobile/Web/remote show an unsupported notice while install management stays usable. A narrow browser viewport is not a real mobile remote-control verification.
- New tests stay in `manual-review/pending` with no automatic CI admission promotion.

## PLM-TEL-001 final-result business telemetry

Pending manual review: `plugins/manual-review/pending/plugin-lifecycle-telemetry.test.ts`. Via a real personal source and the plugin detail install entry, verifies zero results before install, exactly one success result after, with event_id/duration/plugin attribution/entry point present and no operation_id or local paths. Reporting is mocked only at the transport egress; the plugin install runs the real CLI. Not yet promoted to formal CI.

## PLM-UI-BACKGROUND background execution and retention

`PLM-UI-CONNECTION-READY`: opening a page while the session is created or restored but the target MCP initialize has not finished keeps it “preparing”; once the connection is released it auto-advances to running with no error flash, no manual reload, and exactly one instance. Connection failure and session/lease/connection replacement during the wait reject old requests, covered by targeted unit tests. Entry `mcp-apps-host-e2e.mjs --managed-only`; a controlled Electron regression, not promoted to CI.

`PLM-UI-VISIBILITY`: when collapsing the sidebar, switching tabs, leaving the chat page, or switching workspaces, the keep-alive card shows no independent plugin overlay and does not block host clicks; the plugin's two-frame work and in-memory edit state persist, and returning reuses the same guest. A sidebar hidden initially must bind no display anchor. Entry `--managed-only`, light/dark; host page visibility is additionally verified by desktop/mobile shell component regressions.

Controlled Electron regression entry: `node packages/desktop/scripts/mcp-apps-host-e2e.mjs --background-only`. No-card cold start, hidden-but-mounted tabs, multi-frame initialization after handshake, minimized-window execution, internal work continuing while the session idles, same-window idle guest isolation, off-screen-deadline memory retention, and delete/release are detailed in the [background execution contract](plugin-ui-background-execution.md). Point `ZCODE_PHOTOCRAFT_SERVER` at the built PhotoCraft `dist/server.mjs` and use `--photocraft-background-only` to verify real WASM background startup, image/layer operations, and edit-state retention with the unmodified PhotoCraft 0.2.2; after restore, screenshot-check the canvas and new layers; after switching from the visible editor to another main page, assert the UI is hidden and not hit-testable, add a layer in the background, then return and check the same guest and document. This entry is not formal WDIO CI admission and is not auto-promoted.

`PLM-UI-BACKGROUND-ADMISSION`: when the session's tool card is entirely unmounted and the conversation unsubscribed, a real Agent's successful UI tool result still starts a hidden guest; background operations, returning to the same guest, failed results creating nothing, and per-session isolation for the same plugin. The window receiver and display hook racing create only one instance. History restore does not proactively open all plugins. Entry stays `--background-only`; candidate regressions are not auto-promoted to CI.

## PLM-CONCURRENT-INSTALL

Clicking install on two different plugins in quick succession keeps both “installing” with no duplicate submission. When either completes or fails, the other keeps installing; both end in their own final state. Supplemented by same-name concurrency and same-name-operation isolation after context switches.

Browser candidate case: `packages/ui/test/browser/manual-review/pending/plugin-concurrent-install.test.mjs`, real store and shared install buttons, controlled service completion, 390/1200px × zh/en × light/dark. Desktop candidate case: `packages/desktop/test/e2e/plugins/manual-review/pending/plugin-concurrent-install.test.ts`, real personal source and CLI install, failure order controlled by a local HTTP response gate. Both stay pending, not auto-promoted.

## PLM-DETAIL-DURING-INSTALL

While plugin A's install download is unfinished, opening another uninstalled plugin's details loads the component area normally via `plugins/describe`; the plugin list and overview (used by the first load of a newly opened right-side tab) also return immediately without waiting for A's install; A stays installing. A card's “Update” and details' “Restore user defaults” disable only during their own plugin's operation.

Desktop candidate case: one step inside the PLM-CONCURRENT-INSTALL desktop case — real personal source and CLI, the HTTP response gate suspends A's download; with B queued behind A, open the local plugin's details; on return both are still installing; request list/overview through the desktop service chain at the same moment, returning within 10 seconds. Unit tests cover the transport dispatching describe/list/overview immediately, not waiting for the storage lock when the manifest is cached, still entering the lock when the manifest is missing, and both buttons' per-plugin disabling. Stays pending, not auto-promoted.

## PLM-BUILTIN-UI-UNINSTALL

After uninstalling a builtin UI plugin (for example Word documents), the restorable card stays in the “UI plugins” section instead of falling into a category group like “Productivity”. When installed it is likewise in the section.

Desktop candidate case: `packages/desktop/test/e2e/plugins/manual-review/pending/plugin-builtin-ui-uninstall.test.ts`, real CLI, uninstall `documents@zcode-plugins-official` via the card menu, wait for the overview to reach `restorableBuiltins`, then assert the card is inside `plugin-store-ui-section`. A bootstrap unit test verifies that the builtin definition's `ui` component type matches the plugin package's `ui.surfaces`, and that after uninstall both the official catalog and the restorable list carry `ui`. Stays pending, not auto-promoted.
