# Version-gate details do not say the desktop must be upgraded

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`. The version fixture is a compiled-version metadata
variant of the current runtime: Server=`3.16.0`, minimum=`3.16.0`, Desktop=`3.15.1`.

## Facts

In patch 07 the Host log correctly rejects the project connection: `ZCode Desktop 3.15.1 must be upgraded to at least 3.16.0`.
The home page shows only “需要处理 / 请查看详细信息并按提示处理后重试” (needs attention / see details and
follow the prompts, then retry); the test was extended to open real details.

Patch 08, batch `r3-server-20261011143037600-31012b`, `version-controller-required` failed after 223.4 s even
after clicking the banner's "详细信息" (details) and expanding the visible technical details: the dialog text
is still only “需要处理 / 需要更新 / 请查看详细信息并按提示处理后重试”, with no mention of the desktop, the
required version or an action. Video matches `controllerGuidance`; a "scanned home page without opening
details" test problem is excluded.

```text
Host correctly rejects the old Desktop → main UI tells the user to view details
  → details open → still "view details", no statement of what to upgrade
```

The path label on the same page renders the raw `workspaceSidebar.projectPath` key, a visible missing-copy
bug. The remote stays `3.16.0`; the later "original archive SHA unchanged" assertion is not reached and the
version field is not treated as full archive verification.

## Scope

Keep the correct compatibility gate and carry the existing controller upgrade direction, minimum version and
actionable step into the current project details UI. Do not downgrade the remote or leave users guessing at
a directionless "needs update". Tracked separately from
[the optional-update notice issue](21-optional-update-notice-missing.md). Business code is unchanged.

Evidence: patch 07 `version-controller-required` Desktop log; patch 08 `version-policy.json`, failure video
and log of the same case.
