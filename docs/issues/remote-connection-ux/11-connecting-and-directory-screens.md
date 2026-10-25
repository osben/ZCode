# 11 — Connecting Screen and Directory Screen Redo

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:**

- [03 — Remote connection presentation model, 5 states and glossary](./03-presentation-model-states-and-glossary.md): the classified error display depends on it.
- [10 — Three-screen wizard: skeleton, unified selection screen and collapsed progress row](./10-three-screen-wizard-and-selection.md)

**Behavior to deliver:**

**Connecting screen**

- **Top and stage list**:
  - The top shows the device name and a connection-method tag.
  - The stage list is generated per connection method; the current stage is bold and shows elapsed time.
  - Upload and download stages show a progress bar and speed.
- **Cases needing user confirmation**, all confirmed directly in the list without a separate dialog:
  - Installing a new component: show the real version, install location and footprint.
  - Device was reinstalled: after confirmation it is used as a new device.
  - Forced update while tasks are still running: list those tasks.
- **Log and errors**:
  - The log is collapsed by default and expands automatically on failure.
  - Errors are shown by the 03 classification: title, reason, repair actions and copyable details.
- **Bottom and removed items**:
  - Bottom left is "在后台继续" (continue in background), bottom right is "取消连接" (cancel connection).
  - Remove the link diagram and the short device ID.

**Choose-directory screen**

- **Path and jumping**:
  - Show the full path.
  - Clicking a chip under "最近" (recent) or "远端记录" (remote records) makes the directory browser jump there too.
- **Errors and choose-later**:
  - Use friendly copy when a directory cannot be opened.
  - Keep the "稍后选择" added by [08](./08-disconnect-experience-and-in-place-reconnect.md).
- **Boundary note**: "本地离线，任务照常运行" (local offline, tasks keep running) becomes a one-line dismissible hint in the page, shown once.
- **Status bar and rename**:
  - The status bar no longer repeats the device name.
  - Renaming the device gives save feedback.

It corresponds to the second screen, third screen and connecting-screen layout of the "connection wizard (three screens)" section of the parent spec.

Scope:

- **Defects fixed along the way**:
  - Install confirmation showed a fake version and a hard-coded location.
  - The first item of the stage list was cut off.
  - A placeholder appeared in the success banner.
  - Renaming a device gave no feedback.
  - The boundary note interrupted the connection as a dialog.
- **Download progress**: reuses the existing progress events.

**Prototype review conclusion** ([06 review conclusion](./06-interaction-prototype-review.md#comments)): the UI follows the approved prototype; these points follow 06.

- On authentication failure, re-enter the password or key passphrase in place on this screen, with the same interaction as "password required"; only changing the username or private key file returns to the form. The UX spec error classification table is synced.
- Stage name: "确认连接" is renamed "识别设备"; the "连接就绪" stage is removed and success goes directly to the directory screen or opens the project by intent.
- The secondary action copy on deployment failure is "改用设备直接下载". The UX spec is synced.
- The connecting screen's stage list, embedded wait points and error blocks, log collapse rules, and the directory screen layout follow the prototype.

Acceptance criteria (all met):

- Every element of the connecting screen is covered by wizard tests; E2E asserts at the install confirmation step that the real version and install location are shown.
- Upload and download stages show a progress bar and speed.
- Authentication failure, connection refused and deployment-stage failure all show the error and the matching repair action; the first two are covered by E2E.
- The full path, chip jump, directory error copy and "稍后选择" of the directory screen are test-covered.
- The boundary note no longer interrupts the connection as a dialog, covered by E2E.
- Compared with the prototype; screenshots in light, dark and a 900px window.
- UX spec updated and the E2E case catalog synced.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected SSH E2E all pass before the local commit.

## Comments

### Implementation and verification (2026-09-29)

- Within the connecting stages: unified password / key passphrase, install preview, device reinstall confirmation and running-task forced-update confirmation; cancel, collapse and the original directory intent are kept. Stage durations cover ordinary cross-second and midnight cases; upload/download include speed, size and estimated remaining time, and the log keeps merging progress. A real SSH Chinese authentication error, even wrapped by preflight, correctly returns to in-stage credential input.
- Directory chips navigate synchronously and discard late requests; an unconfirmed directory cannot be opened during loading/error; full path, friendly errors, choose-later, name save/failure feedback and the one-time non-blocking hint are in place. The directory status bar does not repeat the device name.
- The technical findings of the dual-axis review were fixed and re-checked. **The user confirmed the scope extension on 2026-09-29**: a read-only install preview and running-task list in the management snapshot, and `running-tasks --json`, are allowed. The parent spec is synced; the persisted status format, task owner, identity isolation and continuous/replayable are unchanged.
- `pnpm typecheck`, `pnpm lint` (64 pre-existing warnings, 0 errors), `pnpm architecture:check --changed`, desktop `typecheck:e2e` and the three-screen fixture check pass. The final affected regression: 32 files, 356 tests passed; the later Chinese authentication / wait icon / status bar regression: 67 passed.
- The full unit run required by implement was executed: 18,718 passed, 14 skipped, 5 failed. One was a terminology assertion superseded by the 06 "识别设备" decision (updated and re-verified); the others were timeout / subprocess exit problems in `desktopResourceTelemetry` (1), `r3RemoteProcess` (2) and `settingService` (1), whose files were not changed, and their independent serial re-run of 66 related tests all passed. A fully green first full run is not claimed and the whole suite was not repeated.
- Final real SSH E2E **4/4 specs pass**: `desktop-e2e-20260928171512189-p86116-9ec1bbe80ceb67aa`, including RDUX-10/11 first install / directory, SSH-P0-CONN-01/02 authentication retry, CONN-06/07 missing credentials and online reuse, RDUX-LOG refused connection. First install took **4 clicks, 1 input**; the real version `3.12.2` and the remote absolute install location are asserted. 24 screenshots (light/dark × 1440/900px: install/directory, selection screen, failure card) plus a refused-connection screenshot were checked against the 06 prototype and stay in the local artifact directory of that run.
- The case catalog and coverage matrix are synced. Pending cases were not promoted manually or admitted to CI. Mobile `/remote` management entry is unchanged and follows the existing full regression; the mobile relay, real phones and real WSL/Docker were not run (the latter two have DOM regressions for stage copy).
