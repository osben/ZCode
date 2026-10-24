# 17: Add SSH / WSL / Docker by Type

Status: done

**Parent:** [#15 — Separating project creation from remote connection management](15-project-device-selection-and-connection-management.md)

**What to build:** New connection in Settings opens the add dialog organized by SSH, WSL and Docker directly. The user chooses a discovery candidate or fills in manually, explicitly clicks "添加并连接", goes through the original authentication and install flow, and on success sees the added device in Settings.

**Blocked by:** [#16 — Connection completes independently in Settings](16-settings-connection-completion.md). This ticket depends on its connection completion intent and independent Settings wrap-up, so a submitted new form is not taken to directory selection.

**Spec coverage:** Q2, Q4, Q5, Q8; the Settings entry of RDUX15-04, RDUX15-05, and re-verification of RDUX15-10/18/21. RDUX15-23/24/25 cover the typed form, platform limits and Settings entry gating.

## Acceptance criteria

- [x] Settings "新建连接" opens the typed add dialog directly, defaulting to SSH; it does not first show a cross-type unified list containing saved devices and does not require selecting an existing device again.
- [x] SSH supports filling from config-file Hosts and manual entry; the existing authentication methods, credential input, advanced options, port validation and necessary error hints stay usable.
- [x] On supported platforms WSL offers distribution discovery and the existing manual entry; Docker offers container discovery and manual configuration. Respect each one's capability limits, and do not conflate Docker unavailable, no running containers and discovery failure into one empty state.
- [x] Choosing a discovery candidate only prepares the configuration and does not start a connection; the primary action is explicitly "添加并连接". Discovery loading or failure does not block other sources and manual entries allowed by existing capabilities.
- [x] When switching connection type or target, an old discovery response must not overwrite the new selection; credentials belong only to the corresponding target, and the previous device's password or key passphrase is not carried to another target.
- [x] After submit, the same authentication, install, upgrade and connection flow is reused. Success stays in Settings and locates the device, creating no project or chat; failure keeps a correctable form and error and does not describe an authentication failure as this credential having been saved.
- [x] A configuration of a not-yet-identified device stays in Settings "未完成的连接"; after identification succeeds the device is displayed with its Source identity, different Profiles of the same Source form no duplicate device; no "save only" mode is added.
- [x] Cancel, close and Esc keep #16's request-ownership protection; existing connection records and shared connections are not wrongly deleted or disconnected; after returning to correct the form it can retry, and navigation or form overrides from the old request are no longer received.
- [x] Type switching, field labels, discovery candidates, errors and the primary action support keyboard, Chinese/English, current dark/light themes and narrow windows; unsupported platforms do not show entries that cannot be completed.
- [x] Interaction tests were added before implementation; Settings tests and helpers that depended on the old selection screen were updated, changing only assertions of the entry completed by this ticket, with evidence and unverified platforms recorded.

## Verification

- From the real Settings entry go through SSH, WSL and Docker discovery and manual configuration to connection completion, asserting device state, Settings location and unchanged project count; WSL is verified in a supported Windows environment.
- UI integration tests control discovery response order, discovery failure and authentication failure, verifying that selection does not dial, explicit submit connects, and old-target results and credentials do not pollute the new form.
- Reuse the real remote test chain to verify authentication/install waiting and failure retry; record the environment actually used for each type; an SSH pass cannot stand for a WSL/Docker pass.
- Implementation must complete typecheck, lint, the architecture gate, affected unit tests and the corresponding E2E, plus applicable platform, theme and narrow-screen checks; new E2E are registered by the existing candidate review process and do not claim formal/CI admission themselves.

## Scope and handoff

- Jumping from the project and chat to this dialog and returning to the original draft are connected by [#20](20-project-draft-settings-round-trip.md) and [#21](21-chat-settings-round-trip.md) respectively; this ticket first fully delivers the add path inside Settings.
- The product meaning of added-device candidates and discovery candidates follows the parent spec. The project dropdown belongs to [#18](18-direct-project-creation-and-device-selection.md); this ticket changes no device or project identity and adds no authentication capability.

## Deferred verification

2026-10-12: the user explicitly asked not to verify the following environments this round. TODOs are kept and not recorded as passing.

- [ ] Real WSL discovery, manual add and connection completion on Windows.
- [ ] Real end-to-end regression of the Web/mobile remote-control entry and Host capability gating.

## Completion evidence (2026-10-12)

- Settings new goes straight into the default SSH typed form; SSH config, WSL distribution and Docker discovery only fill in configuration, and only the explicit "添加并连接" dials. Existing authentication, install, Source merging and cancel ownership are kept.
- Type switching and SSH target changes clear old credentials; late Docker responses, both initial discovery and user-initiated refresh, are invalidated after the type lifecycle ends.
- Verification: `pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm lint` (0 errors, 208 pre-existing warnings), architecture gate (0 violations) and fixture check all pass. Affected root unit tests 668 files / 6391 tests pass; the final remote UI regression 28 files / 295 tests pass.
- Real macOS Desktop + exclusive Linux SSH / Docker environment ran `conversation-session-settings-connection-completion.test.ts`, 2 tests pass: SSH config and manual entry, authentication failure correction, different Profiles of the same Source, online reuse, Docker discovery and manual entry, Esc cancel, Settings location and original-project recovery. Project and chat counts stayed unchanged on all add paths.
- Final evidence: `packages/desktop/.e2e-artifacts/desktop-e2e-20261012103617954-p8589-11f164b179b46093`, including 16 sets of typed-form rectangles and screenshots, 8 sets of Settings screenshots, `settings-completion-facts.json` and the test report; covers Chinese/English, dark/light, 1440 / 480px.
- An early narrow-screen assertion read an intermediate frame of the existing 100ms `transition: all`: at the 480px viewport the width transitions from 672px to 448px (x=16), button right=447 / bottom=789.375, and the stable layout is fully visible. The test now waits for the finite animation's `finished` before measuring; the product layout was not changed and no product timeout was added.
- The old three-screen / walkthrough Settings-entry assertions were migrated to this ticket's semantics; their full historical walkthrough / background scenarios were not re-run, and historical PASS is not reused. The new cases are still pending and do not represent formal / CI admission.
