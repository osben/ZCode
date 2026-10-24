# Sidebar Coding Plan Usage

## Background

The remaining-quota entry in the workspace sidebar footer sits next to the current workspace, so it must
express "the one Coding Plan quota the current model connection mode will consume", not an account-level
overview.

## Rules

1. The sidebar remaining quota shows one source only; the footer menu does not switch between several
   personal / team sources.
2. Current workspace connection mode is personal Coding Plan: query and show the personal remaining quota;
   with no benefit the entry is hidden.
3. Connection mode is BigModel Team Plan: query and show that team project's remaining quota; with no
   benefit or no team project context the entry is hidden.
4. Connection mode is API Key, Start Plan, an ordinary custom provider or a native provider: show no Coding
   Plan remaining quota.
5. A benefit on another account source must not make the sidebar entry fall back to it; e.g. when the
   current connection is personal Coding Plan with no personal benefit but Team has one, the sidebar shows
   nothing, so users are not misled into thinking sends consume Team quota.

## Header

- The panel header shows the Coding Plan title on the left, followed by the ownership tag: personal Coding
  Plan `Individual` / `个人`; Team Plan `Team` / `团队`. The tag only expresses quota ownership and offers no
  switching.
- The Team Plan source name is always `BigModel - <organization name>`; without `organizationName` no Team
  Plan usage source is generated, avoiding the generic `BigModel - Coding Plan` or a blank source.

## Input Box Usage Popover

- The popover keeps a compact one- to three-column quota layout showing quota name, remaining percentage
  and progress bar first. The reset time is measured in JavaScript against the current column width: shown
  if the full "percentage · time" fits, otherwise only the time is hidden.
- After font or popover size changes it re-measures through `ResizeObserver`, so large fonts do not wrap
  the date and squeeze the quota column; full time info is always kept in the settings page "使用统计"
  (Usage statistics).

## Sidebar Profile Badge

- The small badge beside the sidebar avatar is an account-level Coding Plan badge and no longer follows the
  workspace connection mode. With a personal Coding Plan it shows the plan level (e.g. `Pro` / `Max`); with
  no personal plan but a Team Plan it always shows `Team` / `团队`; with both, the personal level wins.
- The `使用统计` entry in the sidebar avatar menu sits above the upgrade entry and opens the settings
  "使用统计", landing on the coding-plan source first.

## Settings Usage Coding Plan

- The settings "使用统计" is an account-level statistics view and no longer follows the workspace
  connection mode.
- Top tabs expand all available statistics sources of the account: `应用用量`, personal `个人套餐`, and each
  Team Plan organization name. An account with a personal Coding Plan shows the `个人套餐` tab (several
  personal sources are told apart by provider name). Each team project of a Team Plan is its own tab whose
  text shows only `organizationName`, with no project, id or product fallback.
- Clicking the personal tab shows only that source's quota and usage; clicking a Team Plan project tab
  shows only that project's quota and usage, and the request must carry `organizationId` / `projectId`.
- A current connection of API Key, Start Plan, an ordinary custom provider or a native provider does not
  affect the usage page showing the account's existing Coding Plan sources.

## Implementation Constraints

- The current connection mode is the workspace's `selectedSupplierKey`.
- BigModel Team Plan still reuses the `builtin:bigmodel-coding-plan` provider; the concrete team project
  comes from the `team-plan:*` selected key in `modelProviderFamilySelectedKeys.bigmodel`.
- A Team Plan quota query must carry `organizationId` / `projectId` so the service layer copies and uses the
  team project API Key.
