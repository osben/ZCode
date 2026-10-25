# Bugfix 07: Coding Plan Entitlement Refresh Triggers Provider Settings Render Loop

> Status: Completed
>
> Date: 2026-08-28
>
> Source: macOS Provider Settings real-machine React #185 (Maximum update depth exceeded)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-07-coding-plan-entitlement-refresh-loop.md`

## 1. Problem and Root Cause

After entering Coding Plan / Team Plan in model settings, the whole Provider settings area could be replaced by the
Scoped Error Boundary with React #185. The production stack ended at `ModelProviderSection`; there was no SQLite,
model request or `reasoningLevel` call chain. `ControlHintTooltip` at the top of the stack is only the refresh
button's component, not the cause.

Cause: after the Family entitlement orchestration refactor, `useProviderFamilyEntitlements` returned a new plain
object every render and `useCodingPlanEntitlements` used whole `zaiFamily` / `bigmodelFamily` objects as `useMemo`
dependencies, so equivalent entitlement facts lost reference stability. Provider navigation is projected from the
entitlement result, so `selectedNavItem` was recreated each time, and the plan access refresh effect, which depended
on the whole `selectedNavItem`, treated loading/snapshot updates of the same plan as "the user re-opened the plan":

```text
Family Hook new object -> entitlement result new object -> navigation re-projects selectedNavItem
  -> plan access effect refreshes -> entitlement setState -> render again -> React #185
```

The common entitlement Hook producing an equivalent state object on a freshness-window hit amplifies the bug but is
not the root cause; common setState is not used as a defense.

## 2. Rules

1. The `useProviderFamilyEntitlements` result depends only on the real provider id, fingerprint, enabled and the four
   entitlement result fields. With unchanged inputs and facts, the Family result and the final
   `useCodingPlanEntitlements` result keep reference stability. The unified Family orchestration is retained (no
   return to duplicate Z.ai / BigModel implementations).
2. The plan access refresh effect depends only on `selectedPlanKey` and the stable refresh function, never on the
   whole `selectedNavItem` (quota, status, Provider projection are volatile):

```text
selectedPlanKey: null -> plan A   --> refresh once
selectedPlanKey: plan A -> plan A --> no refresh
loading/snapshot change of plan A --> no refresh
selectedPlanKey: plan A -> plan B --> refresh once
```

3. No max refresh count, boolean lock, timer or exception swallowing. SQLite, `reasoningLevel`, Provider Registry
   and model execution are untouched.

## 3. Tests

Same Settings View and equivalent connection selection return unchanged entitlement Hook references; Coding Plan
refreshes once on first selection; re-projection and loading/snapshot updates of the same plan do not refresh;
switching Coding Plan to Team Plan or another Family refreshes exactly once; API Key / Personal Provider never
triggers plan entitlement refresh; existing Z.ai, BigModel, Start Plan and Team Plan entitlement query and cache
identity tests keep passing.

## 4. Outcome and Open Items

- Implemented as above; 242 tests in 4 related files, root `pnpm typecheck` and `pnpm lint` passed.
- Full-workspace run had 2 pre-existing failures unrelated to this change (macOS notarize script; SessionPane draft
  prewarm admission). Full `pnpm fmt:check` was blocked by pre-existing Electron fiddle HTML and GB2312 fixture
  issues; touched files passed individually.
- Open: existing `CTP-02` E2E covers opening settings and switching Team Plan, but the Linux run lacked `xvfb-run`
  (Chrome exited before the case). Rerun on macOS or another environment that can launch the desktop app; also
  confirm no crash on BigModel/Z.ai Individual/Team Plan pages in macOS dev runtime.
