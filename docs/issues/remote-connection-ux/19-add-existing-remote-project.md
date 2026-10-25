# 19: Add an Existing Remote Project

Status: done

**Parent:** [#15 — Separating project creation from remote connection management](15-project-device-selection-and-connection-management.md)

**What to build:** After choosing a remote device in the new project form, the user can browse and add the original project through "添加此设备上的已有项目…" and keep accessing its tasks on this machine. This path is clearly separate from creating a project, and returning keeps the uncommitted new-project draft.

**Blocked by:** [#18 — Direct project creation and selecting an existing device](18-direct-project-creation-and-device-selection.md). This ticket needs that form, the selected device and the complete path of explicit connection inside the project.

**Spec coverage:** Q9; RDUX15-15, RDUX15-16, and the offline-connection, waiting and invalidation branches of RDUX15-07/18/20. RDUX15-23/24/25 cover the list's interaction and platform boundary.

## Acceptance criteria

- [x] After choosing a remote device in the project form, the source-folder area offers the secondary entry "添加此设备上的已有项目…"; it does not require filling in a new project name or directory first.
- [x] Clicking enters that device's existing-project list in the same dialog. An offline device connects inside the current project flow, keeps the intent of choosing an existing project; after credential supply, install or retry succeeds it continues the original list and does not enter new-project creation or the Settings add page.
- [x] After the user selects a project in the list, only the local entry of that project is registered, and its original tasks stay accessible; project creation is not called to simulate adding an existing project.
- [x] Different projects at the same device and directory keep different project identities and can be selected separately; adding the same project twice produces no duplicate local entry. The existing semantics of creating a same-directory project are not changed into automatic reuse.
- [x] Returning from the list restores name, device and chosen directories to the original creation draft; list loading, failure, cancel and retry neither overwrite nor submit that draft.
- [x] When an old remote supports only reading existing projects, browsing and adding still work; read-only capability is not misreported as no projects, and unsupported create operations are not allowed.
- [x] If the device is switched, the flow cancelled or the original intent invalidated before the list request returns, the old result must not replace the new device's list, add a project or trigger navigation; cancel only releases this attempt's resources and does not affect shared connections.
- [x] An explicit open/reconnect of an existing project keeps the original project identity and directory and is not treated as another new-project draft; project history and task ownership are neither migrated nor deleted.
- [x] Keyboard selection, return focus, empty/error states, long names and paths of the list work in Chinese/English, current dark/light themes and narrow windows, and Web/mobile follow the original Host capabilities.
- [x] Tests before implementation; the end-to-end identity assertions and cancel verification below are done; the replaced entry and useless wiring are removed only after existing entries are migrated and confirmed to have no users.

## Verification

- Prepare a project with existing tasks on a real remote, add it from the new form and read the original tasks, asserting project ID, task ownership and local entry count; also assert repeated adds, not only that the project name appears.
- Prepare same-directory different projects and an old remote with read-only capability, verifying selection, dedupe and capability gating; follow the existing project service contracts and E2E organization.
- Delay the existing-project list or connection result, release after cancel or target change, and verify the old result has no side effect; when returning to the draft check all original values.
- Implementation passes typecheck, lint, the architecture gate, affected unit tests, the corresponding Desktop E2E, and the applicable shared-UI/mobile regression and visual checks; record the evidence boundary of real-remote and read-only compatibility verification.

## Scope and handoff

- No project dedupe by path, remote project migration or task reassignment is added. Only entries and handoff are adjusted, reusing the existing remote project query and local entry registration.
- Background continue and explicit recovery for this flow are connected by [#22](22-background-connection-and-explicit-resume.md); this ticket's foreground return, cancel and late-result protection must be fully usable first.

## Comments

2026-10-12: per Q9 the existing-project entry and the foreground cancel boundary are done. ProjectEditor keeps the same creation draft, and RemoteProjectList reads only the selected device and, after an explicit selection, registers the entry with the original projectId; the creation path of the old connection entry is kept through a compatibility wrapper. The read-only old remote is verified in the UI and the project service contract: readable, selectable, registrable, creation restricted.

Verification: root `pnpm typecheck`, `pnpm lint` (208 pre-existing warnings, 0 errors), the architecture gate, E2E type and fixture checks pass. This ticket's `--files` affected selection of 661 test files, the main Vitest group 657 files / 6367 tests and the Node audit pass; the 4 contracts of old remote / project storage and entry pass 24 tests. After merging #20, 5 files / 93 key regression tests for creation / Settings return / cancel and startup credentials pass.

Real SSH Desktop E2E passes 1/1: original project and task ID/ownership, two projects at the same directory, entry ID/count unchanged after repeated add, return to the draft, late-list cancel, and continuing the original list after explicit offline connection are all asserted. Evidence: `packages/desktop/.e2e-artifacts/desktop-e2e-20261012110913073-p90850-7427869e2d36d636/`. 8 sets of screenshots (Chinese/English × Zai Light/Dark × 1440/480px) were checked. A geometry regression first found that the default grid row height of 48px could not hold 65px of text (scrollTop=0); with content row height, row-by-row boundary assertions and all screenshots pass. Failure evidence is kept in `desktop-e2e-20261012110708521-p87877-215c3ab6cbef90b0`.

Evidence boundary: real SSH uses the current runtime; old-version binaries were not run separately, and the compatibility branch is verified by the existing legacy service fixture and observable UI tests. Real WSL and phones are kept as TODO at the user's request and not marked as passing. The new E2E is still manual-review/pending, not promoted or added to CI.
