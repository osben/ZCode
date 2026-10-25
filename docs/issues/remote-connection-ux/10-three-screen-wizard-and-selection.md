# 10 — Three-Screen Wizard: Skeleton, Unified Selection Screen and Collapsed Progress Row

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:**

- [04 — Wizard P0 fixes and flow controller extraction](./04-wizard-p0-fixes-and-flow-controller.md)
- [06 — Interaction prototype and review](./06-interaction-prototype-review.md)

**Behavior to deliver:**

Per the approved prototype, change the connection wizard to three screens: select → connecting → choose directory.

- **Overall structure**: remove the left step bar and replace it with a lightweight progress hint at the top; wizard height adapts to content.
- **First screen: a searchable unified list**, containing:
  - saved devices, each with its recent directories;
  - Hosts in `~/.ssh/config`;
  - detected WSL distributions, shown only on Windows;
  - running Docker containers, shown only when Docker is available.

  The list bottom has "新建 SSH 连接" (new SSH connection) and manual entries for WSL and Docker. Clicking any item starts connecting directly. The recent directories of an offline device are also clickable, meaning "connect and open".

- **Collapse**: after collapsing the wizard, a progress row shows at the top of the sidebar project area; clicking restores the wizard; a connection failure result is kept until the user views it.
- **Close**: closing the wizard cancels the connection and clears the draft; input history is kept.

It corresponds to the overall structure, first screen, form, collapse and close parts of the "connection wizard (three screens)" section of the parent spec.

Scope:

- **Form**:
  - Field-level validation: the port must be numeric; host and username are trimmed.
  - Enter submits, and focus follows to the new screen on screen switch.
- **Defects fixed along the way**:
  - The alias hint appears only when an alias is really selected, and not twice.
  - The Docker dropdown selection and manual input are mutually exclusive, each labelled; "Docker unavailable" and "no running containers" are two different hints.
  - WSL is not shown on macOS.
  - The release build does not show dev-mode hints.
  - A first-time user was marked "step 1 completed", and step 2 flashed first when known connections existed.
- **State owner**: the connecting state has exactly one owner, the wizard session; the sidebar progress row only reads this state and keeps no copy.

**Prototype review conclusion** ([06 review conclusion](./06-interaction-prototype-review.md#comments)): the UI follows the approved prototype; these points follow 06.

- The collapsed sidebar progress row becomes a two-line small card: the first line "正在连接 <设备名>…" and a percentage, the second line the current stage, with a progress bar below; after failure it stays as a danger-colored card stating the reason and clickable to view. This differs from the parent spec's single-line form; this ticket prevails.
- Grouping, layout and footer of the selection screen and the new SSH form follow the prototype.

Acceptance criteria (all met):

- **Operation count of the first SSH connection**: starting from a config Host, through entering the password, install confirmation and choosing a directory, about 4-5 clicks and 1 input in total. E2E records the actual click count.
- **First-screen list**: list sources, search and click-to-connect work per spec with wizard tests; clicking an offline device's recent directory connects and opens that directory, covered by E2E.
- **Form and defect fixes**: form validation, Enter submit, focus movement, and the Docker, WSL, macOS and dev-hint fixes are all test-covered.
- **Collapse and close**: after collapsing the sidebar shows the progress row and the failure result is kept; after closing the draft is cleared. Covered by tests and E2E.
- **Single owner**: the sidebar progress row reads only the wizard session state, with no second copy.
- **Visual check**: the UI matches the prototype screenshots; extra screenshots in light, dark and a 900px window.
- **Spec update**: update the UX spec and navigation spec and sync the E2E case catalog.
- **Pre-commit checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected SSH E2E all pass before the local commit.

## Comments

### Implementation and acceptance (2026-09-29)

- The three-screen top progress, unified search list, SSH form layout and Docker/WSL manual entries are implemented; an offline recent directory connects and opens along the original route. The config, connecting and directory screens can all be collapsed and restored; the directory request is revoked on unmount, and closing or changing target clears the draft. The sidebar registers only a DOM container and the card is rendered directly by the single wizard session.
- 54 wizard DOM regressions pass, covering the WSL external preference, alias retention after a config read failure, late directory responses, clearing on close, background success wrap-up and existing-connection intent. Edit-connection and SSH helper regressions are synced.
- RDUX-10-01 to 04 real SSH E2E pass: `desktop-e2e-20260928160405047-p51001-d93013e144937095`. From config Host first install to opening a directory measured **5 button clicks and 1 password input**; offline recent directory, collapsed failure retention, viewing and draft clearing on close are asserted. 16 screenshots in total (light/dark × 1440/900px: selection screen, saved device, new SSH, failure card) were checked against the 06 prototype and stay in the local artifact directory of that run.
- SSH CONN-01/02 and CONN-03 pass in the two corresponding specs of `desktop-e2e-20260928160027687-p49292-629542e903aac76c`; CONN-06/07 pass in `desktop-e2e-20260928160405047-p51001-d93013e144937095`. The new cases are still Pending, not promoted manually or admitted to CI.
- The two-axis review (conventions/spec) has no unresolved finding.
- The extra global case coverage audit still reports the pre-existing D19/I74/I75 references and statistics and generated-document drift; re-checking with the catalog/matrix of the implementation start `bcc1ae5fc885d451975d59925cbb3f6e75195801` gives the same errors. The new fixture contract check passes and these existing document issues are not extended.
- Final verification: `pnpm typecheck`, `pnpm lint` (64 pre-existing warnings, 0 errors), `pnpm architecture:check --changed`, desktop `typecheck:e2e` and the new fixture check pass. The final unit run collected 2,035 files and 18,726 tests, **18,712 passing and 14 pre-existing skips**; two native/subprocess loading checks timed out in an earlier concurrent run, and their independent serial re-run passed 4/4, with the final full run passing too. Mobile `/remote` interaction is unchanged; related existing unit tests ran in the full regression and the mobile relay E2E was not re-run.
