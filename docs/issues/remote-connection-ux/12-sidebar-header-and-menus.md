# 12 — Sidebar, Session Header and Menus

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:** [03 — Remote connection presentation model, 5 states and glossary](./03-presentation-model-states-and-glossary.md), [06 — Interaction prototype and review](./06-interaction-prototype-review.md)

**Behavior to deliver:**

- **Project row**:
  - Single-line layout: one status icon slot, project name, device name.
  - The status icon has four forms: a single spinner, a crossed-out cloud, a cloud with `!`, a cloud with `✕`.
  - The device name uses the secondary text color with limited width; when the device is not online this position shows a short status text instead.
  - Remove the ⓘ icon, the duplicate spinner and the always-visible reconnect button; row-end actions appear only on hover or keyboard focus.
- **Detail card**:
  - Click the device label to open immediately; hover opens after about 400ms.
  - Shows device, connection, path, state and reason.
  - Actions: connect or disconnect, edit connection, manage in Settings (jumps to the Settings page and locates this device's card).
- **"项目 +" (project +) menu**: "打开远程项目" (open remote project) expands into a device list. An online device goes straight to directory selection; an offline device connects first and then selects a directory. The last item is "新建远程连接…" (new remote connection…).
- **Session header**: permanently shows the device name and status icon.
- **Other places**:
  - The project switch menu in the composer shows the device name.
  - The device label on task rows is styled the same in all views.

It corresponds to the "sidebar, detail card and session header" section of the parent spec.

Scope:

- **Detail card layout fixes**:
  - The divider spans the full card width.
  - The status label is right-aligned.
  - It does not cover in-row actions or the time column.
  - The type tag uses normal casing.
- **Other fixes**:
  - No tooltip remains after the project menu closes.
  - The name and path in the session header hover hint match the sidebar.
  - An online device that is only connected with no project open also appears in the "打开远程项目" list.

**Prototype review conclusion** ([06 review conclusion](./06-interaction-prototype-review.md#comments)): the UI follows the approved prototype; these points follow 06.

- The detail card anchors to the whole row and pops out on the sidebar's right without covering row-end actions.
- The device status label reads "state · reason phrase", for example "连接中 · 自动恢复 2/3", no longer concatenated directly.
- The project row uses the short recovery copy "自动恢复 2/3"; the full sentence is only in the detail card.
- The connection description uses normal casing, for example `Docker · …`, no longer `DOCKER`.

Acceptance criteria (all met):

- At the default sidebar width of 264px, the visible width of the project name is clearly larger than the walkthrough baseline, confirmed by screenshot comparison.
- Project rows in the 5 states look like the prototype: component tests assert the icon and short status text come from the presentation model, with screenshots.
- The detail card's popup delay, each action, and jumping to and locating in Settings are tested; "在设置中管理" is covered by E2E.
- The "打开远程项目" menu lists devices, including online devices that are connected but have no project open.
- The session header and the project switch menu both show the device name, so same-named projects on different devices can be told apart.
- In all task views the task-row device label style is consistent.
- Screenshots cover light and dark themes, Chinese and English, and a 900px-wide window.
- The navigation spec is updated and the E2E case catalog synced.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected E2E all pass before the local commit.

## Verification Record (2026-09-29)

- The project row uses a single status icon and width-limited device name / short model status; details share one 400ms hover/click overlay, and edit, device disconnect, original-directory connect and Settings card location reuse existing entries. Session and remote-draft headers, the project switch menu and task labels are synced.
- The dual-axis review (conventions/requirements) passed; the findings (multi-route preference override, draft header gap, repeated consumption of the locate intent, focus takeover timer) were fixed with regressions. Real E2E also reproduced and fixed Radix's automatic anchor overriding the virtual anchor, so the overlay stays on the row's right after returning to the project page.
- Five-state real components compared side by side with the starting HEAD row component, project-name space at 264px in Chinese: online 101→105px, recovering 64→125px, offline 126→154px, needs action 116→144px, failed 12→144px; 8 screenshots (Chinese/English, dark/light, 1400/900px) in `packages/desktop/.e2e-artifacts/rdux12-visual`. The temporary visual entry was cleaned up and not committed.
- Real SSH E2E `conversation-session-remote-sidebar-menus` passes, run `desktop-e2e-20260928191550395-p40953-3f34da887a24cf8d`: online device with no project entering a directory, header device name, edit connection, manage location, disconnect and original-directory reconnect, no tooltip after menu close; 16 in-app Chinese/English, dark/light, 1400/900px online/offline screenshots, with the detail asserted on the row's right. The new case stays pending, the fixture check passes; catalog, coverage matrix and server execution queue are synced.
- Final targeted UI regression: 66 passed; after fixing two inconsistent old acceptances (remote spec queue registration, draft header static assertion) 21 related tests pass. Mobile had only existing unit-test regression and no real-device visual verification; the Linux full remote queue was not run.
- `pnpm typecheck`, desktop E2E type check, `pnpm lint` (64 pre-existing warnings, 0 errors) and `pnpm architecture:check --changed` (0 violations) pass.
- The full unit run completed (`ZCODE_TEST_POOL=forks`, 2 workers): 2,034 files / 18,741 passing, 2 files / 14 skipped by existing condition; the two failures were exactly the remote list registration and the old draft source assertion above, fixed and verified by the 21 targeted tests. No failure remains. High-concurrency threads on this machine once hit memory pressure and aborted, so the repository-supported isolated mode was used for the full run.
