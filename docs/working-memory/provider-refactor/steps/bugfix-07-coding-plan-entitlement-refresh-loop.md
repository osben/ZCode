# Bugfix 07: Coding Plan Entitlement Refresh Triggers Provider Settings Page Render Infinite Loop

> Status: Completed
>
> Date: 2026-08-28
>
> Source: The macOS Provider Settings real-machine encounters the React #185 (Maximum update depth exceeded)

## 1. Problem

After the user enters the Coding Plan / Team Plan in the model settings, the entire Provider settings area may be replaced with the React #185 error page by the Scoped Error Boundary. The production component stack falls on `ModelProviderSection`, with no SQLite, model request, or `reasoningLevel` call chain.

This is not the database corruption, nor is it caused by the `reasoningLevel -> variant` usage persistence mapping. The `ControlHintTooltip` appears at the top of the component stack because the Provider settings layout's refresh button uses that component; the same Tooltip/Select structure independent reproduction does not form a loop.

## 2. Root Cause

After the Family entitlement orchestration refactoring, the `useProviderFamilyEntitlements` returns a new plain object for every render; the final `useMemo` of the `useCodingPlanEntitlements` uses the entire `zaiFamily`, `bigmodelFamily` object as a dependency, causing the equivalent entitlement facts to lose reference stability as well.

The Provider navigation is projected from the entitlement result. The change of the entitlement object recreates the navigation item and the `selectedNavItem` each time. The plan access refresh effect depends on the entire `selectedNavItem`, thus misjudging the "loading/snapshot display update of the same plan" as "the user re-opened the plan."

```text
The Family Hook returns a new object for every render
        |
        v
The entitlement result returns a new object for every render
        |
        v
The navigation projects the selectedNavItem again
        |
        v
The plan access effect refreshes again
        |
        v
The entitlement setState renders again
        |
        `------------------------> React #185
```

The common entitlement Hook still generates an equivalent state object when it hits the freshness window; this amplifies the incorrect dependency, but is not the root cause of this bug; this Bugfix does not use the common setState as a defense to cover the Provider settings page's incorrect trigger semantics.

## 3. Fix Principles

### 3.1 The Family Entitlement Result Stably Maintains Based on the Real Fact

- The return object of the `useProviderFamilyEntitlements` depends on the actual provider id, fingerprint, enabled, and the four entitlement result fields;
- When the input and entitlement facts do not change, the Family result and the final result of the `useCodingPlanEntitlements` maintain reference stability;
- Retain the unified Family orchestration; do not revert to the Z.ai / BigModel duplicate implementation.

### 3.2 The Plan Access Refresh Only Responds to the Selection Identity Change

```text
selectedPlanKey: null -> plan A  --> Refresh once
selectedPlanKey: plan A -> plan A --> Do not refresh
The loading/snapshot change of plan A  --> Do not refresh
selectedPlanKey: plan A -> plan B --> Refresh once
```

- The effect only depends on the `selectedPlanKey` and the stable refresh function;
- Do not depend on the entire `selectedNavItem` containing the quota, status, Provider projection, and other volatile fields;
- Do not add the maximum refresh count, boolean lock, timer, or exception swallowing.

## 4. Test

Write the failure tests first, then implement the fix:

- The same Provider Settings View and the re-render when the equivalent connection selection returns unchanged references for the entitlement Hook;
- The Coding Plan is triggered once when it is selected for the first time;
- The same plan object is re-projected; the entitlement loading/snapshot update does not trigger again;
- The Coding Plan switches to the Team Plan or another Family; it refreshes exactly once;
- The API Key / Personal Provider does not trigger the plan entitlement access refresh;
- The existing Z.ai, BigModel, Start Plan, and Team Plan entitlement query and cache identity tests continue to pass.

## 5. Completion Criteria

- The React #185 is no longer triggered by the plan entitlement refresh on the Provider settings page;
- The plan access refresh semantics is consolidated from "object change" to "selection identity change";
- The return value of the Family refactored Hook has a stable reference;
- The SQLite, the `reasoningLevel`, the Provider Registry, and the model execution chain are not modified;
- The UI targeted test, the `pnpm typecheck`, the `pnpm lint`, and the format check pass;
- The macOS development runtime does not crash when entering the BigModel/Z.ai Individual/Team Plan pages.

## 6. Implementation Result

- The Family entitlement Hook now produces a new reference only when the actual Provider, access identity, or entitlement fact changes;
- The plan access refresh is consolidated from the entire navigation object to the stable `selectedPlanKey`;
- The API Key / Personal Provider does not trigger the plan access refresh; the same plan's quota and loading update does not refresh repeatedly;
- Retain the Family unified orchestration, the Provider Registry, the SQLite, and the `reasoningLevel` existing boundaries; no loop count gate or exception fallback is added;
- The 242 tests across 4 related test files pass; the root `pnpm typecheck` and the `pnpm lint` pass;
- 12,717 unit tests pass across the full workspace; 2 existing failures remain, one in the macOS notarize script and the other in the SessionPane draft prewarm admission; neither has file or call chain intersection with this round's Provider entitlement Hook changes;
- The full workspace `pnpm fmt:check` is still blocked by the existing Electron fiddle HTML syntax and the GB2312 fixture; the files modified in this round pass the format check individually.
- The existing `CTP-02` E2E happens to cover opening the settings page and switching the Team Plan; the local production build passes, but the Linux lacks the `xvfb-run`, and the Chrome session exits before executing the test case; the macOS run verification still needs to be rerun in an environment that can launch the desktop application.
