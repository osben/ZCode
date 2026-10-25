# open() Same-Site Tab Reuse (`reuseTab`) Design Record

- Date: 2026-08-24
- Origin: BUA user feedback "every time the page is operated a new page is opened, and after the task the right-side embedded browser is full of tabs"; see also ticket ZCT-2090747918255304704 (same theme; the real causes there were two orthogonal lines: instant screenshot failure and the settings page cutting the subscription).

## Background and diagnosis

Tab pile-up came from three factors, all in the monorepo tool layer and unrelated to the desktop main process:

1. `browser.open(url)` unconditionally ran `tabs.new()` + `goto()` (the old facade.ts implementation, from an old bugfix "open must create an agent-owned tab").
2. There was no code reusing an existing tab by URL: `urlMatchRank` in `selection.ts` was only used to pick a backend, and tab reuse relied on the model following the `tabs.list() -> get(id)` documentation flow, with no code fallback.
3. By design a finished task does not close tabs (see `browser-use-plugin/docs/tab-cleanup-iab.md`), so the right panel only fills up.

The `navigate` command itself never opens a tab: main `resolveTab` (browserGuestManager.ts) already has a complete currentTab reuse chain. The problem is only `open()` and the model's calling habits.

## Design (confirmed by the user)

```
open(url?, { reuseTab = true } = {}):
  browser = getDefault()
  if url && reuseTab:
    tabs.list()                     // only agent-owned tabs of this scope, never takes over a user tab
    selectTabForUrl(url, tabs):     // urlMatchRank, threshold rank <= 2 (same hostname)
                                    // rank 3 parent/child domain is not reused (may be a different site, risk of a wrong jump)
                                    // among equal ranks prefer active, otherwise the newest
    hit  -> activateTab (activate so the user sees it) -> goto(url) in place -> return
    miss / list failure -> degrade to tabs.new() + goto (the reuse path never blocks the task)
  else (no url / reuseTab:false) -> tabs.new() + goto
```

Key trade-offs:

- **Default `reuseTab: true`**: the fix must reuse by default; a default of false would return to the soft constraint of "relying on the model".
- **Explicit escape hatch kept**: when the model is half-way through a form and wants a same-site comparison page, default reuse would navigate the form page away; passing `reuseTab: false` or `tabs.new()` forces a parallel tab.
- The semantics of `tabs.new()` are unchanged, main is untouched, and no recycling at task end (user's choice, keeping the existing design of tab-cleanup-iab.md).

## Touch points

- `apps/zcode-cli/packages/core/src/browser-client/selection.ts`: pure function `selectTabForUrl()` (shares `urlMatchRank` with `selectBrowserForUrl`).
- `apps/zcode-cli/packages/core/src/browser-client/facade.ts`: `BrowserTabs.reuse(url)` (one list + activateTab); `open()` hooks in and degrades as a whole.
- `apps/zcode-cli/packages/core/src/browser-client/documentation.ts`: fallback docs teach `open()` as the default navigation entry.
- `apps/zcode-cli/packages/browser-use-plugin/skills/control-browser/SKILL.md` and `docs/overview.md`: model guidance in sync.
- `apps/zcode-cli/packages/core/tests/browser-client.test.ts`: cases for exact/same-domain/parent-child domain/no match/list-failure degrade/no url/`reuseTab:false`/active preferred/newest fallback.

Command sequence assertions: reuse path `[list, activateTab{tabId}, navigate{url, tabId}]`; degrade path `[list, newTab, navigate]`.

## Release

Plugin version `0.3.1 -> 0.4.0`; the five version sources are bumped in sync per `docs/browser-use/2026-08-14-browser-use-plugin-version-0-3-0-spec.md`. Risk of not bumping: desktop would hit the `0.3.1` stale seed and the old SKILL.md and an old api.json without the `open` declaration would never ship.

Also fixed in the same change: the tool-contracts guard was red on the staging baseline because the `js_reset`/`js_add_node_module_dir` metadata was out of sync with permission/timeout declarations. `sideEffectScope` metadata said `system` while permission always applied `none` (unified to `none`, matching sibling tools), and both tools lacked `metadata.timeoutMs` (added `5000`, equal to `SHORT_TIMEOUT.defaultMs`). Runtime approval and timeout behavior is unchanged. Known remaining red on the staging baseline, unrelated to this change: `bash-run-conformance` (hard-coded developer absolute path), `io-boundary`, `runtime-module-boundary`.

## Known boundaries

- A model calling `browser.tabs.new()` directly still opens a new tab (explicit semantics, not closed off); if pile-up is still seen online, first check the source of the `newTab` command in the model trajectory.
- Reuse matching looks only at the URL and is unaware of page state; a half-filled form depends on the model passing `reuseTab: false` (taught in the docs).
- The policy of not recycling tabs at task end is unchanged; for a later cap-based recycle or one-click cleanup see point 3 of "Background" and the `keep` mechanism of tab-cleanup-iab.md.

## Addendum: manifest hideUnknown blind spot

During doc sync it was found that the REPL-injected `agent.browsers` is a hideUnknown proxy from `asRuntimeObject()` (facade.ts), so `open()` not declared in the `Browsers` manifest is hidden as **undefined**, and a call taught by SKILL.md would throw TypeError. Bare-facade unit tests never go through the proxy and could not catch it. Fix:

- declare it in both manifests: core `FALLBACK_MANIFEST` and the plugin `docs/api.json` (the two must be maintained in sync);
- the old test assertion "open must be undefined" (locking the old design of hiding open as a compat entry) was reversed into a visibility guard;
- new cases go through the real `asRuntimeObject()` proxy path.

Lesson: **when adding a model-visible API, declare it in the manifest (both places) and test through the proxy path**; direct tests on a bare object are a blind spot.
