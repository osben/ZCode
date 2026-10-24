# Browser Use New-URL Wait, Generic-Target Click and New-Tab Recovery Guidance Spec

> Status: implemented, contract verified
> Date: 2026-07-31
> Scope: ZCode CLI Browser Use agent guidance (Skill, bundled docs, fallback docs)

## 1. Background and problem

In one page snapshot the target book title was exposed as a `heading`; the page did not declare it a
`link`:

- ZCode rewrote the title to a guessed `link` role, `count()` returned `0`, it concluded "the title is not
  a link" and did not click.
- The correct action is to keep the snapshot-proven heading/text locator and click the `h3`: the card's
  JavaScript click handler receives the bubbled event and opens the detail page in a new tab.
- If, after the click, only the source tab URL is checked and it is unchanged, the model clicks again; the
  trajectory showed two identical detail tabs opened.

The problem is not the underlying click ability but action planning and the post-action observation
protocol:

1. The agent must not replace the snapshot's real semantic role with a guessed role.
2. When user intent authorizes navigation and the target text is unique, a generic heading/text can be a
   click target.
3. An unchanged source-tab URL does not prove the click failed; the page may navigate through a popup/new
   tab.
4. After each state-changing action, observe before deciding to retry, to avoid duplicate side effects.
5. After an action, a non-empty controlled list is not success; whether the action's expected effect
   appears in the source page, a controlled tab or a claimable user tab must be judged.
6. When an action may open a popup/new tab and the source tab shows no expected effect, splitting the two
   tab queries into two observation cells lets the model re-decide after the first result and skip the
   second, still missing the new window.
7. The standard new-URL trajectory is `tab.goto(url)` followed by an explicit
   `tab.playwright.waitForLoadState({ state: "domcontentloaded" })`, then reading title, URL or DOM. The
   ZCode runtime `goto()` already waits for Electron navigation to finish, but the guidance had dropped the
   step, leaving model trajectories without an explicit wait.

## 2. Goals

- For JavaScript-driven cards, titles and visible text, use snapshot evidence instead of requiring an
  `<a>` / `link` role.
- When the source tab URL is unchanged, check agent-controlled tabs and claimable user tabs before
  re-locating.
- Judge success after an action by whether the expected URL, title or page state appears; an existing
  source tab or unrelated controlled tab is not an action effect.
- When an action may open a new window and the source tab shows no expected effect, read
  `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell, return
  both states together and make a single model decision.
- One state-changing action per observation cycle, to avoid duplicate tab opens, submissions or purchases.
- Fix the new-URL trajectory as `goto()` -> explicit `waitForLoadState({ state: "domcontentloaded" })` ->
  first page observation, so the model-visible call order is stable.
- Locator strictness, actionability, safety approval, tab claiming and multi-client delivery boundaries
  stay unchanged.

## 3. Non-goals

- No change to the runtime implementation of Playwright locators, Electron CDP trusted input, popup routing
  or tab claiming.
- No change to the underlying completion condition of `goto()` or the 3000ms runtime cap of the existing
  URL/load-state wait; only the provider-visible explicit call sequence is unified.
- No new aggregate tab API; the existing Node REPL cell combines the two read-only queries.
- No new protocol field; `desktop-continuous` / `web-remote-replayable` unchanged.
- No site-specific selectors or scripts.
- Generic clicking is not upgraded into a permission that bypasses approval.
- No new Conversation E2E: model-provider differences and real-site changes are unfit as deterministic
  gates.

## 4. Impact brief

Capability: `capability.browser-use-agent-guidance`. Change layer: guidance sequencing + validation +
recovery. Primary seeds: `control-browser/SKILL.md`, Browser API manifest/included docs, `documentation.ts`
fallback, Node REPL tool description, tab recovery runtime hint, contract tests. Out of scope: browser
runtime, CDP, protocol, UI, remote sync, site specialization.

### 4.1 Surface matrix

| Scenario                                            | Shared implementation                                  | Validation / gating                                                                                                                                                                  | Commit action                                                                                              | Boundary                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| User asks to open the detail page of a unique title | Browser Skill + dynamic docs                           | snapshot real target type, `count() === 1`, existing safety approval                                                                                                                 | `locator.click()`, at most once per observation cycle                                                      | desktop and web remote share agent guidance; each delivers results over its existing path                                              |
| User asks to open a new URL                         | Browser Skill + API semantics + included/fallback docs | after a successful `goto()` wait explicitly for `domcontentloaded`, then read title/URL/DOM                                                                                          | `tab.goto(url)` -> `tab.playwright.waitForLoadState(...)`                                                  | `goto()` runtime completion, protocol, task snapshot, relay untouched                                                                  |
| Source URL unchanged after click                    | tab list / claim API                                   | when an action may open a new window, read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally and concurrently in one observation cell, return together, judge once | activate/claim the tab that shows the expected effect; no second click before the full observation returns | desktop continuous and mobile replayable semantics unchanged; independent of pre-action tab selection, UI drafts, remote command queue |

Shared vs different: the Skill, API semantics, dynamic docs and Node REPL tool description jointly
constrain default behavior; the fallback doc keeps only minimal key rules, but no injection path may
revert to split popup observation. New URLs always use `goto` -> `domcontentloaded` -> observation; a tab
already at the target URL does not `goto` again; click navigation follows the post-action expected-effect
protocol. Pre-action target-tab selection still returns a list first and binds afterwards; user tabs still
need an explicit claim.

### 4.2 Relationships and state owners

- Guides tool planning in `capability.agent-core-runtime` (keep Skill, included docs, fallback consistent);
  covered by `evidence.browser-use-agent-guidance-tests` (`browser-manifest.test.ts`); must not change
  delivery for `boundary.desktop-continuous` and `boundary.web-remote-replayable` (popup observation does
  not become task recovery state).

| State/fact                                  | Authoritative owner                      | Commit command/service                                           | Persistence            |
| ------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| role and text of the target in the snapshot | current page DOM snapshot                | none; only for locator planning                                  | none                   |
| DOMContentLoaded after new-URL navigation   | browser backend's current tab load state | `tab.playwright.waitForLoadState({ state: "domcontentloaded" })` | none                   |
| whether the click happened                  | browser backend                          | `locator.click()`                                                | browser tab runtime    |
| whether a new tab appeared                  | controlled/user tab registries           | `tabs.list()` / `user.openTabs()` / `user.claimTab()`            | existing tab ownership |

### 4.3 Must-preserve invariants

| Invariant                                                                                                       | Proof                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A snapshot-proven `heading` is never rewritten to a guessed `link` role                                         | Skill, bundled docs, fallback all state it (BCP-218)                                                                                                     |
| With authorized navigation and a unique target, heading/text may be clicked directly                            | guidance states "real type first" (BCP-218)                                                                                                              |
| Observe after each state-changing action; no retry before observing                                             | Skill/workflow/playwright docs consistent (BCP-219)                                                                                                      |
| Success after an action is judged only by the expected URL/title/page state, not by a non-empty controlled list | old source tab / unrelated controlled tab is not an effect; with no expected effect continue to claimable user tabs (BCP-219)                            |
| The two popup-recovery tab queries return together in one observation cell, with no model decision between them | Skill, API semantics, bundled/fallback docs and tool description use the same atomic observation rule and forbid separate/dedicated list calls (BCP-219) |
| Pre-action tab selection and post-action popup observation are two different protocols                          | API/Skill state the former "observe, then bind" and the latter "return both states in the same cell" (BCP-219 + existing tab recovery tests)             |
| After a new-URL `goto()`, wait explicitly for `domcontentloaded` before the first page read                     | Skill, API semantics, included docs, Playwright docs and fallback use one call order (BCP-223)                                                           |
| The explicit wait only aligns guidance trajectory; runtime timeout and navigation owner unchanged               | no runtime/protocol/UI diff; docs keep the 3000ms cap and no `networkidle` (BCP-223 + diff check)                                                        |
| Safety approval and destructive-action boundaries unchanged                                                     | existing safety docs and runtime tests pass                                                                                                              |
| Desktop/mobile delivery unchanged                                                                               | no protocol/runtime/UI diff; typecheck/lint                                                                                                              |

### 4.4 Code evidence

No Codegraph tool was available; symbol/path scans (`rg`) were used as depth-2 static evidence.

- `loadBrowserDocumentation`: Browser MCP manifest -> bundled docs / `FALLBACK_DOCUMENTATION`; both must be
  updated.
- `locator.click`: core Playwright facade -> desktop locator executor -> CDP input; clicking non-link
  elements already works, no runtime change.
- `browser.tabs.list` / `browser.user.openTabs`: a Node REPL cell can `Promise.all` the two read-only calls;
  ambient context already reads both registries in parallel; then `tabs.get` / `user.claimTab` by evidence.
  No runtime helper needed.
- `buildJsToolDescription` / `TAB_CONTEXT_RECOVERY_HINT`: provider-visible Node REPL metadata and the
  desktop stale-binding error both shape model recovery planning; the difference between post-action atomic
  observation and pre-action stale-binding recovery must be explicit.
- `Tab.goto` / `PlaywrightAPI.waitForLoadState`: the Browser facade maps navigate and the Playwright action
  separately; Skill, included docs, API semantics and fallback decide the model call order.

Graph delta: `capability.browser-use-agent-guidance.codeSeeds` gains the API manifest,
`buildJsToolDescription`, `TAB_CONTEXT_RECOVERY_HINT` and `docs/playwright.md` seeds plus a navigation
wait alias; no new capability, owner or delivery relation. No open questions. Real-model/site smoke is a
non-blocking later check. Coverage matrix: `docs/testing/browser-use-codex-parity-coverage-matrix.md`
BCP-218/219/223; no Conversation E2E case catalog entry needed.

## 5. Behavior

### 5.1 New-URL navigation wait

```text
verified new URL
      |
      v
tab.goto(url)
      |
      v
tab.playwright.waitForLoadState({ state: "domcontentloaded" })
      |
      v
first title / URL / domSnapshot observation
```

1. Run `goto()` only when the task points at a not-yet-open new URL; do not re-navigate when already at the
   target URL.
2. After every successful `tab.goto(url)`, before the first title, URL or DOM read, call
   `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })` explicitly.
3. This is a model trajectory contract: even if the backend `goto()` already awaits navigation, guidance
   examples must not omit it.
4. Do not substitute the unsupported `networkidle`, or a fixed `waitForTimeout()` for an observable load
   state.
5. The existing routine URL/load-state wait cap of 3000ms is unchanged; runtime timeout semantics are not
   modified.

### 5.2 Locating

1. Call `domSnapshot()` first; locators must come from the current snapshot.
2. Keep the real target type exposed by the snapshot. If the target is a `heading`, do not guess `link` to
   make it "clickable".
3. When the user explicitly asked to open/enter that unique target, a snapshot-proven heading, visible text
   or generic element may be clicked.
4. Clicking a generic element still requires `count() === 1`, actionability and safety approval; the rule
   does not authorize fuzzy hits or bypassing confirmation.
5. A DOM click may bubble to an ancestor's JavaScript card handler; an HTML role is not a prerequisite for
   clickability.

### 5.3 Post-action observation

```text
fresh snapshot
      |
      v
snapshot-proven locator -- count === 1 --> click once
                                              |
                                              v
                                observe expected URL/title/state
                                      /                 \
                             effect present          effect absent
                                  |                       |
                            inspect/use result       can action open new tab?
                                                    /                  \
                                                  yes                  no
                                                   |                    |
                                      one observation cell:       targeted source
                                      Promise.all([               observation /
                                        browser.tabs.list(),      fresh snapshot
                                        browser.user.openTabs()
                                      ])
                                                   |
                                      return { controlledTabs,
                                               userTabs }
                                                   |
                                          one model decision
                                            /             \
                              expected effect found?       no effect
                                      |                       |
                              activate/claim/use          fresh snapshot,
                                                        choose new plan
```

- One observation cycle allows only one state-changing action.
- An unchanged source-tab URL only means "no URL navigation finished in the source tab", not that the
  click failed.
- After an action, judge whether the action's expected URL, title or page state appears; a non-empty
  `browser.tabs.list()`, a surviving old source tab or an unrelated controlled tab is not an action
  effect.
- When an action may open a popup/new tab and the source tab shows no expected effect, read
  `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell;
  `Promise.all` is recommended, and `{ controlledTabs, userTabs }` is returned together as the cell's final
  result.
- The model must not re-decide before both tab states are fully returned; do not return controlled tabs
  alone and then decide from them whether to query user tabs.
- After the combined result, the model judges the effect once: match a controlled or claimable tab by
  expected id/url/title/state, then if needed run `tabs.get` or `user.claimTab` in the next cell.
- "Select the target tab before operating" remains a separate protocol: first show the model the candidate
  list, then bind the target in the next cell; do not misapply it to post-action popup observation.
- Do not click again before this observation completes.
- When the source page, controlled tabs and claimable tabs all lack the expected effect, take a fresh
  snapshot and pick a new locator; never blindly retry on stale evidence.

## 6. Acceptance cases

| Case    | Setup                                                                                                                       | Action                       | Assertions                                                                                                                                                                                                                                       | Evidence layers                                                                     | E2E status |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------- |
| BCP-218 | snapshot has only a unique `heading`/visible text, no `link` role                                                           | plan a locator               | guidance requires keeping the real type, allows clicking a unique generic target under user authorization, forbids guessing `link`                                                                                                               | Skill + bundled docs + fallback contract                                            | not-needed |
| BCP-219 | click may trigger a popup; source tab URL/state shows no expected effect; controlled list still contains the old source tab | post-action recovery         | the same observation cell reads and returns controlled/user tabs unconditionally; no model decision between the two queries; after the combined return the expected URL/title/state is judged once; no second click before observation completes | Skill + API semantics + bundled/fallback docs + Node REPL tool description contract | not-needed |
| BCP-223 | the task provides a not-yet-open new URL                                                                                    | create a tab and `goto(url)` | Skill, API semantics, overview/workflow/playwright and fallback all require an explicit `waitForLoadState({ state: "domcontentloaded" })` before the first page observation; no `networkidle` or fixed sleep                                     | core Browser guidance contract                                                      | not-needed |

## 7. Pruning decisions

| ID        | Pruned combinations                              | Guard/invariant                              | Reason                                                                | Representative coverage                    |
| --------- | ------------------------------------------------ | -------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| PRUNE-001 | DOM and selector of a specific book site         | rules must rely on generic snapshot evidence | avoid site specialization and brittle fixtures                        | BCP-218                                    |
| PRUNE-002 | every model provider x reasoning effort          | the doc contract is the deterministic gate   | model output varies by sampling, unfit as a commit gate               | BCP-218/219/223                            |
| PRUNE-003 | desktop/mobile each running popup/navigation E2E | runtime and delivery unchanged               | existing tab/runtime coverage already verifies the underlying ability | BCP-219/223 + existing tab lifecycle tests |

## 8. Verification

Red phase confirmed: the same-cell two-query assertion on API semantics and the Node REPL model-visible
tool description failed as expected (old guidance allowed re-deciding on half the tab evidence), and the
contract failed without the explicit `domcontentloaded` call in `navigationWait`.

Passed: `pnpm exec vitest run tests/browser-manifest.test.ts tests/node-repl-tools.test.ts
tests/node-repl-browser-injection.test.ts` (3 files / 37 tests; Skill, API manifest,
overview/workflow/playwright, effective/fallback docs, tool description and tab registry injection
compatibility); `pnpm exec vitest run packages/desktop/test/browserGuestManager.test.ts` (1 file / 57
tests; the stale-binding hint is limited to pre-action recovery and not mixed with post-action popup
observation); `pnpm --filter @zcode/browser-use-plugin test` (6 files / 29 tests); `@zcode/core
typecheck`; `@zcode/browser-use-plugin build`; ZCode CLI workspace typecheck (23/23 tasks); root `pnpm
typecheck`; root `pnpm lint` (36 warnings, 0 errors, none in changed files); feature graph YAML/edge/seed
validation (150 nodes, 259 edges, 217 code seeds, no duplicates, dangling edges or missing seeds). A
rescan for contradictory wording found every provider-visible new-URL path as `goto` -> `domcontentloaded`
-> first observation with the 3000ms cap; the old "return the controlled list first" and "separate
observation" wording remains only in negative contract assertions.
