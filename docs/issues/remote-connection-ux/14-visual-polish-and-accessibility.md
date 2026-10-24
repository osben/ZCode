# 14 — Visual Polish and Accessibility

Status: done

**Parent spec:** [Remote Connection Interaction and Visual Experience Optimization](./01-remote-connection-ux-optimization.md)

**Blocked by:**

- [11 — Connecting screen and directory screen redo](./11-connecting-and-directory-screens.md)
- [12 — Sidebar, session header and menus](./12-sidebar-header-and-menus.md)
- [13 — Settings device cards, unfinished connections and update notices](./13-settings-device-cards-and-updates.md)

**Behavior to deliver:**

After the main screens are redone, do one unified wrap-up of the remote UI covering dark theme, design guidelines, text details, keyboard and screen readers, so all of these users can use it smoothly.

- **Dark theme contrast**: text-to-background contrast of status labels, the sidebar and the Settings navigation is sufficient to read clearly.
- **Design guideline violation cleanup**:
  - font sizes outside the type scale;
  - hard-coded colors and arbitrary-value colors;
  - icon sizes and corner radii outside the guidelines.
- **Text details**:
  - placeholder fonts in inputs are uniform;
  - description text is not truncated;
  - the last line of a Chinese paragraph is not a single character.
- **Keyboard operation**:
  - all actions of the wizard, sidebar project rows and settings cards can be done by keyboard only;
  - focus moves sensibly.
- **Screen readers**:
  - selection controls announce the selected state;
  - labels are correctly associated with their controls;
  - connection state can be read out;
  - the accessible name of the dialog close button is localized.
- **Other details**:
  - the password field can toggle show and hide;
  - the private key select button uses a file icon;
  - the preview while dragging a project keeps the device label.

It corresponds to the "design system" section of the parent spec and the remaining low-priority items of the defect list.

Scope:

- **Old code cleanup**: old device-grouping code and comment blocks with no production references are first confirmed deletable by the old-main-chain deletion list of the main spec, then cleaned.

Acceptance criteria (all met):

- **Screenshot review**: all combinations of light and dark themes, Chinese and English, sidebar 264px and window 900px; all contrast problems are fixed.
- **Automated tests**: extend the token compliance test and semantic-surface contrast test of the remote UI to cover the screens in this ticket; all pass.
- **Keyboard walkthrough**: the full flows of the wizard, sidebar project rows and settings cards can be done by keyboard only, with the walkthrough result recorded.
- **Screen reader tests**: selected state, label association and the accessible name of connection state are test-covered.
- **Pre-commit checks**: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, affected unit tests and affected E2E all pass before the local commit.

## Comments

Implementation and acceptance, 2026-09-29:

- Start `44ac7aeedd23924b4c4aa214117c5e92c22b353e`, clean working tree. A remote secondary-text token was introduced; label, state description, password show/hide, history candidates and Docker list keyboard operation were completed; dragging keeps the device name; old device-grouping components and helpers with no production references were deleted, keeping stable identity and legacy alias parsing.
- `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm lint` and `pnpm architecture:check --changed` pass. Lint has 65 pre-existing warnings and 0 errors; architecture 0 violations.
- Affected unit tests cover 373 files, 3892 tests. The final batch of 372 files passed; the remaining project-row test asserted the visible short label separately from the new screen-reader description, and its 10 targeted re-runs all passed. The full unit suite was not run. Existing mobile Web layout, remote-control task and relay recovery unit tests are included.
- The range selector at the start commit reported incomplete because of two unchanged static-asset imports (mp3 / html?url) and the deleted old group header; the tests it identified, the new history keyboard test and the sidebar section test were written as an explicit list and run through `pnpm test:unit:affected --files-manifest`. The old group header and grouping functions were confirmed to have no production calls by an unscoped dep:refs and repo-wide reference search, and the identity helpers keep their regression.
- Real SSH E2E `conversation-session-remote-accessibility.test.ts` passes: new-target install, password show/hide, download switch, directory input, project Enter, detail/more menu, settings-card disconnect and connect, choose-later, history candidate refill and close are all done by keyboard; pointer dragging verifies the device label separately. Test credentials are injected by the fixture.
- Screenshots reviewed: selection screen, form, install confirmation, directory screen, sidebar detail and settings card, 8 each, 48 in total, covering light/dark × Chinese/English × 1400/900px; each screenshot asserts the sidebar is 264px. The 96 state-surface combinations and the contrast of secondary text and type tags on the four themes pass the 4.5:1 gate.
- Local evidence: `packages/desktop/.e2e-artifacts/rdux14-accessibility/`, with `summary.json`, six `*-matrix.jpg`, originals, `drag-device.png`, the test list and check logs. Screen readers were verified through DOM accessible name/description/selected-state tests; native VoiceOver/NVDA were not run; WSL/Docker controls pass component tests and the real-device chain uses SSH.
- code-review dual-axis re-check: Standards left no finding; the history-keyboard and password-toggle omissions raised by Spec were fixed and re-checked. The new E2E stays in manual-review/pending, not yet promoted manually or added to Docker CI.
