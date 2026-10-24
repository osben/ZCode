# Sidebar Coding Plan Upgrade Entry

## Background

The sidebar avatar menu keeps a Coding Plan upgrade entry so users always have a stable path from the account menu to plan purchase/renewal. The entry no longer depends on quota / remaining / subscription snapshots, so it cannot disappear while logged out, on a plain API key, or while plan state is temporarily unavailable.

## Visibility

The "Upgrade" menu item is always shown in the avatar menu. It is not hidden for:

- Not logged in or OAuth restoring.
- Current model is not a Coding Plan.
- Coding Plan provider unavailable, unconfigured, or entitlement still loading.
- Entitlement returns `no_plan` / `unavailable` / already has a plan / Team / Enterprise / Max.

## Behavior

Clicking "Upgrade" opens the existing `CodingPlanUpgradeDialog`:

- If the current context resolves a Z.ai / BigModel Coding Plan provider, that provider opens.
- If no provider can be resolved, Z.ai Coding Plan opens by default.
- If the current entitlement is recognized as Max, the label still says renew; otherwise it says upgrade.
