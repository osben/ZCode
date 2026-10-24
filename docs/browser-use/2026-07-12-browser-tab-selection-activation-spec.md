# Browser Tab selection, activation and operation pre-check spec

> Status: product semantics confirmed. Supplements `2026-07-12-browser-tab-process-lifetime-spec.md` and defines consistency between "which tab the model selects" and "which tab the user sees" in multi-tab scenarios. Selection and transparent restore of suspended tabs are also bound by `2026-07-31-browser-tab-residency-budget-spec.md`.

## Change summary

| Field               | Decision                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change              | `browser.tabs.get(id)` changes from pure object binding to "bind + activate"; a foreground scope shows the target tab, a background scope only records the activation state       |
| Model pre-check     | Each logical browser operation batch first returns `tabs.list()` to the model in a separate JS call; the next JS call confirms the target by id/url/title and runs `tabs.get(id)` |
| User-visible result | After a successful get the target browser-use tab becomes the current side-pane active tab and the right sidebar expands                                                          |
| State owner         | main `BrowserGuestManager` holds the selected tab; the renderer side pane holds the foreground visible tab                                                                        |
| Out of scope        | repeating list for every locator/snapshot action after the target was confirmed in the same JS cell; adaptive renderer budget                                                     |

## Clarification log and fixed boundaries

| Requirement                        | Fixed boundary                                                                                                             | Reason                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs.get` should activate the tab | every get sends an explicit `activateTab` backend command                                                                  | an agent-only returned Tab object must not leave the UI showing another page                                                                        |
| multi-tab selection errs easily    | for each logical operation batch the model must re-list -> observe the result -> match -> get                              | must not rely on `globalThis.tab` of the previous turn/cell or array position; a silent list inside the SDK does not count as observed by the model |
| "every operation" granularity      | pre-check once before a logical batch; consecutive actions in the same cell after the target is confirmed do not repeat it | keeps auditable tab-selection evidence without a pointless round trip per locator action                                                            |

No undefined product branch remains.

## Boundary decisions

| Boundary                     | Required behavior                                                                                                                                                                   | Forbidden                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tabs.list()`                | returns all logical tabs of the current scope (including suspended) with id/url/title and at most one `active`; `active` means "which tab a command without tabId lands on"         | restoring all guests just to list; several tabs claiming active; using `active` as a proxy for "currently visible in the UI" (visibility goes through the independent `browserVisibilitySet/Get`)                                                |
| target matching (model side) | the model first receives the full list result; prefer a stable id, otherwise match by an explicit url/title given by the user or in the latest list                                 | blindly choosing `[0]`, `at(-1)` with multiple tabs, selecting silently in the same unobserved cell, or reusing a global tab of unknown origin (this row constrains model-side disambiguation only, not the system fallback in the next section) |
| `tabs.get(id)`               | validate the logical id still exists; if suspended, restore it single-flight first, then notify the backend to activate, and return the Tab only on success                         | constructing only a local object without updating the UI; silently creating an empty page for a tab whose restore failed                                                                                                                         |
| activation side effects      | update the main selected tab, mark other tabs of the same scope inactive; show/expand the target view only when that scope is in the foreground                                     | a background conversation taking over the current workspace/session UI; executing page actions after activation failed                                                                                                                           |
| follow-up actions            | use the exact tabId returned by this get                                                                                                                                            | degrading to "the current default tab" or a cross-scope tab                                                                                                                                                                                      |
| `tabs.selected()`            | only reads the current effective active; not a substitute for an explicit user choice                                                                                               | using the return value as the basis of multi-tab disambiguation, or skipping the list -> match -> get pre-check because of it                                                                                                                    |
| system effective active      | with no explicit selected tab, main falls back in a fixed order to a unique active (next section) so the `active` of `tabs.list()` equals the landing tab of commands without tabId | treating this fallback as the model's target selection; overriding an existing explicit selected with the fallback                                                                                                                               |

### System effective-active fallback (not model target selection)

The position guessing forbidden by "target matching (model side)" constrains **model-side disambiguation** only. It does not apply to the following two places, where no "explicit user/model selection" exists and the system must give a deterministic answer:

- computing the `active` field of `tabs.list()`;
- `resolveTab()`: where a command carrying **no tabId at all** lands.

The order of `BrowserGuestManager.effectiveActiveTabId()`, stopping at the first hit:

1. `activeTabByScope` (the result of an explicit `tabs.get` / activation) and that tab is not closed;
2. a tab reporting itself `active` (before claim a human tab only sets `tab.active` and does not write `activeTabByScope`);
3. the most recent non-closed logical tab of that scope (`logicalOwnedTabs(context).at(-1)`).

Because it stops at the first hit, the same scope still has at most one `active=true`, so the invariant of `tabs.list()` in the table above is unchanged.

**Precondition of step 3**: the scope has neither an explicit active nor a self-reported active tab. The typical state is a **session running in the background**: the renderer's `isVisible = pane expanded && tab selected` is always false in the background, so it only reports `attachGuest({ active: false })`, and both `activeTabByScope` and `defaultTabByScope` are empty. Without the fallback, `tabs.list()` reports zero active tabs, downstream addressing by `active` never gets the end-of-turn screenshot (see `2026-07-15-browser-turn-final-screenshot-spec.md`), and `resolveTab()` would open an empty tab out of nowhere, making the `active` reported by list differ from the actual landing tab.

**Not allowed**: the model must not use `active` or `tabs.selected()` in place of the `list -> match -> get` pre-check; the multi-tab disambiguation rules of BTA-005 / BTA-007 are not loosened by this fallback. The fallback is a "the system must give a landing tab" safety net, not a promise that "the last tab is what the user wants".

An isomorphic fallback already existed in the implementation before this section: the visibility path of `browserGuestManager.ts` and `tabs.selected()` of the CLI facade (`find(active) ?? at(-1)`). This section writes it down as a cross-layer consistent system semantic instead of independent ad-hoc fallbacks.

## Domain scope and high-risk cross-products

The main domain is the browser client facade, the browser command protocol, the desktop main tab registry and the renderer side pane.

- list result x user manually switching tabs: the next logical operation must re-list and not trust the old active.
- several agent-created tabs x the same URL: disambiguate by stable id or more known facts; no position guessing.
- active tab x collapsed side pane: an explicit get should still send show/activate so the user sees the page about to be operated.
- background session/workspace x activate event: the renderer may only update the owner tab in the background and must not take over the current active scope.
- desktop-continuous x web-remote-replayable: commands still go through the shared host; no new layer below relay/main is added for tab state.

## Concept map and state owners

| Concept                                          | Owner                                                                   | Evidence                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------- |
| list/get facade and Tab binding                  | `apps/zcode-cli/packages/core/src/browser-client/facade.ts`             | command trace + core unit test           |
| command schema                                   | `packages/shared` and the mirror in `apps/zcode-cli/packages/contracts` | runtime schema parse test                |
| selected logical tab, scope, visibility callback | `BrowserGuestManager`                                                   | manager unit test + response meta        |
| suspended/restoring and guest residency          | `BrowserTabResidencyCoordinator` (to be implemented)                    | residency policy/repository/Electron E2E |
| side-pane active/reveal                          | `applyBrowserUseSidePaneEvent` / `useAppPanels`                         | UI state unit test                       |
| model operation rules                            | browser-use plugin skill/docs/API semantics                             | documentation assembly test              |

## Candidate combinations

| Case    | State                                                              | Event                                                  | Expected effect                                                                                                                                                     | Classification                                             |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| BTA-001 | in the current conversation A active, B background                 | `tabs.get(B)`                                          | list -> activate B; B active/visible, A inactive                                                                                                                    | accepted; old implementation bug-candidate                 |
| BTA-002 | foreground scope's side pane collapsed, B already selected         | `tabs.get(B)`                                          | still sends activate/show and re-expands B                                                                                                                          | accepted                                                   |
| BTA-003 | conversation X in the background, the user watching conversation Y | X runs `tabs.get(B)`, then the user switches back to X | the backend sets B as X's active and remembers the preference; Y's task, side pane and active tab are unchanged; after switching back to X, B is shown and expanded | accepted                                                   |
| BTA-004 | target closed after list                                           | `tabs.get(id)`                                         | activate fails explicitly, no operable Tab returned                                                                                                                 | accepted                                                   |
| BTA-005 | multiple tabs                                                      | new logical operation batch                            | the first JS returns list; after the model observes, the second JS matches by id/url/title -> get -> action                                                         | accepted                                                   |
| BTA-006 | target already got in the same cell                                | consecutive snapshot/click                             | keep using the exact tabId, no forced repeated list                                                                                                                 | pruned; the target did not change across an async boundary |
| BTA-007 | multiple tabs cannot be matched uniquely                           | preparing an action                                    | first obtain more visible facts or ask the user; no position guessing                                                                                               | accepted                                                   |
| BTA-008 | target logical tab already suspended                               | `tabs.get(id)`                                         | restore the same stable id then activate; the guest id may change; return a typed error on failure                                                                  | accepted; follows the tab residency policy                 |

## Assertions and evidence

| Case        | Assertions                                                                                                                                                                                                               | Evidence                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| BTA-001/002 | core command order is list -> activateTab; manager selected/meta points to B; visibility callback receives B                                                                                                             | core + desktop unit tests       |
| BTA-003     | callback/active map applies only to the full browser scope; the renderer records X's preferred tab but keeps Y in the foreground; after switching back to X, B is restored and expanded even if Y had collapsed the pane | desktop manager + UI scope test |
| BTA-004     | an unknown/stale id returns a structured error and no activate callback                                                                                                                                                  | core + manager unit tests       |
| BTA-005/007 | effective documentation clearly contains the pre-check and the ban on position guessing                                                                                                                                  | browser manifest test           |

## Coverage and E2E handoff

- Update `docs/testing/browser-use-codex-parity-coverage-matrix.md` with the BCP-053/054/055 activation, background scope and pre-check assertions.
- This change is proven mechanically with shared schema, core facade, desktop manager and UI state unit tests, with no new conversation E2E.
- A later real UI E2E can open pages A/B, show A first, run `tabs.get(B)`, and assert the B trigger and B webview are activated together.
- No new mobile replay snapshot field; workspace identity, remoteSessionId and owner/lease routing are unchanged.
