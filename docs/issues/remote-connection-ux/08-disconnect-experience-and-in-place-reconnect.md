# 08 — Disconnect Experience and In-Place Reconnect

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:**

- [03 — Remote connection presentation model, 5 states and glossary](./03-presentation-model-states-and-glossary.md): the banner and project-row states are read from the presentation model.
- [04 — Wizard P0 fixes and flow controller extraction](./04-wizard-p0-fixes-and-flow-controller.md): the wizard must land directly on the corresponding wait point.

**Behavior to deliver:**

- **Session area when disconnected**:
  - A banner appears at the top of the session stating the state and reason, with "重新连接" (reconnect) and "详情" (details) actions. If remote tasks are still running, the banner says they keep running.
  - The session page is no longer blank.
  - The composer keeps the draft but cannot send for now, and states why. Nothing is queued while offline and nothing is sent automatically after reconnecting.
- **Task views when disconnected**:
  - An offline project keeps one placeholder row in each of the timeline, group, pinned and archived views.
  - ⌘K search shows readable copy.
- **Reconnect**:
  - With complete credentials, clicking reconnect completes inside the project row without a wizard.
  - When reconnect fails, the project row shows the failure reason; clicking opens the wizard's "connecting" screen with the log expanded.
  - When user action is needed (for example missing information), the wizard stops directly at the corresponding wait point.
- **Unified entry rule**:
  - These four entries follow one intent rule: the sidebar reconnect button, clicking an offline project row, "连接" in the detail card, and "连接" in Settings.
  - If an entry carries no directory, after connecting it goes to directory selection, where "稍后选择" (choose later) is available.

It corresponds to the "session area" section of the parent spec and the in-place reconnect and entry intent parts of the "reconnect and recovery" section.

Scope:

- **Content-area placeholder**: at least the placeholder "设备未连接，连接后继续此会话" (device not connected; continue this session after connecting). Already-loaded session content is kept read-only only while the existing owner still holds it; no new cache owner is added for this.
- **Send failure under a race**: show the classified error copy with "重新连接". The feedback category must not read "model call error".
- **"稍后选择"**: added to the existing choose-directory step; [11](./11-connecting-and-directory-screens.md) keeps it when redoing the directory screen.

**Prototype review conclusion** ([06 review conclusion](./06-interaction-prototype-review.md#comments)): the UI follows the approved prototype; these points follow 06.

- The session banner uses a semantic-color background as a whole, a neutral state's title uses the primary text color, and the right side has "详情" and the primary action.
- On connection failure or reconnecting, already-loaded content is kept as a faded read-only view (no new cache owner); on user-initiated disconnect with no loaded content, show the placeholder "设备未连接，连接后继续此会话".
- The composer keeps the draft and states the reason next to the send button when sending is impossible.

Acceptance criteria (all met):

- After a user-initiated disconnect the session page shows the banner and placeholder, not blank. E2E covers the path where the walkthrough reproduced the blank page.
- The composer keeps the draft, sending is unavailable and the placeholder text explains why; nothing is queued and nothing is sent automatically after reconnect. Needs session-area tests.
- A send failure caused by a race shows classified error copy and "重新连接", with the correct feedback category.
- In every task view an offline project keeps one placeholder row from which connecting can be started.
- ⌘K search no longer shows `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`.
- With complete credentials, in-place reconnect: no wizard, the project row shows "连接中", and the user is not disturbed after success. Covered by E2E.
- When reconnect fails or needs user action, the wizard lands on the right screen and wait point. Needs wizard tests.
- The four entries follow the same intent rule; connecting from Settings goes to directory selection with "稍后选择" available. Covered by E2E.
- The corresponding paragraphs of the UX spec and navigation spec are updated and the E2E case catalog is synced.
- Committed locally after all of these pass: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests, affected SSH E2E.

## Implementation and Verification Record (2026-09-28)

- Disconnect session banner, read-only content/draft, send gate, task-view placeholders, classified feedback and the unified reconnect entry are implemented. Ordinary failures and logs stay in the existing owner; when interaction is needed the flow hands off to the single wizard, keeping the original directory intent.
- Real-phone testing added the path where, after a Source disconnect, invalidated services are unregistered, the current Root is kept and the replayable bridge is rebuilt. After an explicit reconnect succeeds, it waits for the old recovery to finish and re-checks the workspace, avoiding a lost recovery wake or cross-project recovery; the corresponding race regression tests went red then green.
- The dual-axis review (conventions/spec) left no open issue. `pnpm typecheck`, `pnpm lint` (0 errors, 64 pre-existing warnings), `pnpm architecture:check --changed` (0 violations), E2E type and fixture checks passed. The full unit run (`ZCODE_TEST_POOL=forks pnpm test:unit`) finished with 2,033 files / 18,694 passing and 2 files / 14 cases skipped by configuration; the only failing file had two old assertions still requiring the sidebar to open the wizard directly. They were updated to the confirmed unified project-reconnect entry of this ticket, and the final changed unit tests plus the failing file were re-run serially: 20 files / 294 passed. The last change touched only test assertions and init error checks, so the full suite was not repeated; the first full run's exit code is not described as success, and an earlier default-thread-pool out-of-memory is not passing evidence.
- Local Electron RPN E2E PASS `desktop-e2e-20260927163345863-p2314-13cd15bfd21db756`: offline placeholders in group, timeline, pinned and archived views, device details, and credential wait entry.
- Real SSH E2E PASS `r3-server-rdux08-visual-20260928-04`: the original blank-page path, draft kept and not submitted, complete-credential in-place reconnect, and "稍后选择" after connecting from Settings; desktop 1400/480px dark/light screenshots checked.
- Mobile real relay + SSH E2E PASS `r3-server-rdux08-mobile-20260928-11`: desktop keeps running while the phone network is down, mobile replay recovery, both-end FIFO with no loss or duplicate, no extra Host/SSH/Agent, and after an SSH Source disconnect the mobile banner, draft send blocking, mobile in-place reconnect and 390px dark/light themes.
- SSH parameters come from the repository harness (`harness/remote/README.md`), which creates isolated containers and injects temporary credentials; bypassing that entry the first time caused missing environment variables and does not mean the user must configure anything. Test accounts isolate online marketing popups through the existing account mock and initialize first-run preferences through the normal UI. Test environment: macOS Desktop → local isolated Linux Docker container, phone as Chrome mobile viewport + real test relay; real phones and cross-machine WAN are not covered.
- The candidate E2E stays pending; no manual promotion or Docker CI admission. Committed locally per the implementation agreement, not pushed.
