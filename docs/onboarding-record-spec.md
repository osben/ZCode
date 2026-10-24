# Onboarding Record Local Persistence Spec

> Status: implemented (local storage stage; the server upload API is pending, `uploadState`
> reserved for it).

## 1. Background and goals

The new-user onboarding (OccupationOnboarding, three-step wizard: occupation / mode / preferences)
currently only writes preferences into `~/.zcode/v2/setting.json` (`onboardingOccupation` and
related fields) on completion, with no standalone completion record. Product requirements:

1. Persist the three pages' collected data to an **independent local JSON file**, later opened for
   server upload.
2. Records anchor on the **device id (deviceMid)**, support **multiple user ids** (several people
   logging in on one machine) and **no user id** (apikey, not logged in).
3. Onboarding auto-shows only for identities not yet activated on this machine: no answers /
   eligibility decision and never created a real task/session. Existing users with local tasks are
   silently recorded as `existing_local_user`; users who close it as `dismissed`; neither is shown
   again.

## 2. Data structure

Schema in `packages/shared/src/onboardingRecord.ts` (types + zod, a standalone file, not merged
into `validationAppSettings.ts`):

```ts
interface OnboardingRecordEntry {
  userId: string | null; // OAuth user_id; null for apikey/not logged in
  occupation: string; // developer | ... | other (non-empty string, forward-compatible)
  interfaceMode: "coding" | "office";
  memoryEnabled: boolean;
  proactiveSuggestionsEnabled: boolean;
  completedAt: string; // ISO time
  uploadState: "pending"; // reserved: becomes "uploaded" after upload
}

interface OnboardingRecordFile {
  version: 2;
  deviceMid: string; // fixed on first write, never changes
  entries: OnboardingRecordEntry[]; // at most one per userId (including null); re-completing overwrites (reset to pending; readers tolerate old duplicates by taking the last)
  decisions: Array<{
    userId: string | null;
    status: "dismissed" | "existing_local_user";
    reason: "user_closed" | "existing_local_task";
    decidedAt: string;
  }>;
}
```

`entries` hold questionnaire answers and the future upload queue; `decisions` express only local
display eligibility and are never uploaded. v1 files get no startup migration: read as
`decisions: []`, naturally becoming v2 on the next business write.

**Skip semantics**: skipping is an explicit answer. A skipped page records `null` for its fields
(occupation page → `occupation: null`; mode page → `interfaceMode: null`; preferences page → both
booleans `null`), distinct from an explicit choice. The settings side still writes conservative
defaults on skip (occupation `other` / preferences off); the distinction exists only in this record
file.

Location: `getAppConfigDir()/onboarding-record.json` (i.e. `getDataBaseDir()/.zcode/v2/`, default
`~/.zcode/v2/`; follows dataBaseDir for custom data directories, like telemetry-state.json and
other device-level data). Unlike setting.json — which stays fixed in home because startup needs to
read dataBaseDir from a fixed location. Atomic writes.

## 3. Association semantics

```
+----------------+          +---------------------------+
| deviceMid      |<---------| onboarding-record.json     |
| (stable local) |          |  version: 2                |
+----------------+          |  entries: [                |
                            |    { userId: "u1", ... },  |  user A completes onboarding
                            |    { userId: "u2", ... },  |  user B later
                            |    { userId: null, ... },  |  anonymous/apikey
                            |  ]                         |
                            +---------------------------+
                                           |
                                           | later upload (API pending)
                                           v
                                  server (payload carries deviceMid + userId)
```

- `deviceMid` comes from the renderer via `platform.getDeviceId()` (desktop: SHA-256 of the
  userData path, stable); after the first write, the **file's value is authoritative** and repeat
  writes never change it.
- `userId` is completed inside the service via
  `oauthCredentialRepo.loadActiveUserProfile()?.id ?? null`; the UI never touches the OAuth layer.

## 3.5 Login claim (claimAnonymousRecord)

"Answered anonymously once → logs in" must not be re-onboarded as a new user: before deciding for a
logged-in user, claim — if that userId has no entry but an anonymous (null) entry exists, the null
entry is **transferred** to that userId (rewritten, not copied, so one onboarding act never becomes
two entries polluting upload stats).

```
[] → anonymous answer → [null]
  → login A: transfer → [A] (no onboarding re-trigger)
    → logout, answer anonymously → [A, null]
      → login B: B has no entry → transfer null → [A, B]
        → switch back to A: A has an entry → untouched
```

- Claiming covers both answer entries and eligibility decisions, and happens only when the logging-in
  user has neither; in state [A, null], logging in A is an idempotent no-op.
- The anonymous state losing its record and re-triggering onboarding is expected (that state truly
  has no record of its own).
- The UI must await the claim before `shouldOnboard`; reading the pre-claim file would wrongly
  decide onboarding is needed.

## 4. Trigger rules (shouldOnboard)

```
startup / login-state change (zustand user changes)
        |
        v
 resolve userId = loadActiveUserProfile()?.id ?? null
        |
        v
 entries or decisions contain a userId match ? -- yes --> don't trigger
        | no
        v
 local usage evidence (any one hit = existing user)? -- yes --> write existing_local_user, don't trigger
        | no
        v
 trigger onboarding (completion writes an entry; closing writes dismissed)
```

- Logged-in users match `userId` exactly; anonymous / apikey match `userId === null`.
- **Usage evidence (2026-10 revision) is "any one hit", three sources checked in order**:
  1. any Task in the device-global tasks-index (`includeDeleted: true`, including deleted
     tombstones — users who cleared their task list keep existing-user status);
  2. the agent session DB (default `~/.zcode/cli/db/db.sqlite`, expanded by homedir, not following
     dataBaseDir; env/config overrides and skip-on-unknown rules below; SQLite read-only query of
     the `session` table having at least one row);
  3. a non-empty legacy task snapshot directory (`{dataBaseDir}/.zcode/v2/sessions/`, including
     `.deleted.json`).
- **Why tasks-index alone is not enough**: the index is a derived projection of the session
  synchronizer, which only backfills after agent/provider readiness — but the decision runs at
  login completion / main-window mount, before backfill. Empty index ≠ no history (2026-10 online
  case: after an index rebuild in a dev data directory, the login-time decision saw an empty index
  and an old user was wrongly onboarding-prompted; forensics later confirmed all historical task
  rows were in WAL and landed after the decision).
- **Session evidence must query DB rows, never file existence or the cli/sessions directory**
  (review CR-01): a file existing does not mean sessions exist (empty/fresh DB); `cli/sessions` is
  a workflow file-output directory (`script-workflow-tool-port.ts`) — using it would misclassify
  workflow-using new users as existing.
- **The session DB path mirrors only sources the host can deterministically reproduce; anything
  undeterminable is skipped as "unknown"** (review round 3, CR-01: the host does not replicate the
  full CLI resolution rules — relative paths resolve against the agent workspace cwd, project-level
  configs stack per workspace; the host cannot mirror either). Mirrorable sources in order:
  1. env `ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB` (both aliases coexist; on collision the later
     env key wins, matching the CLI env adapter's override order);
  2. `storage.sessionDbPath` in `~/.zcode/cli/config.json` (the CLI `createConfig` default user
     config lives in home, **not following the app dataBaseDir**);
  3. default `~/.zcode/cli/db/db.sqlite` (`~/` expanded by homedir).
  Only absolute paths (including `~/`-expanded) count as evidence locations; relative → unknown →
  skip this source (continue with the legacy snapshot directory), never guess against the host cwd.
  Config read/parse failure (non-ENOENT) throws: with the config unreadable the session DB location
  is unknown, and guessing the default would miss existing users with a custom session DB.
- The session DB is queried over a read-only connection; WAL rows not yet checkpointed are visible
  to it regardless of backfill timing. A missing DB file (stat ENOENT) means no evidence; **other
  errors (EACCES/ENOTDIR etc.) are rethrown** and the UI conservatively does not prompt (review
  CR-02: existsSync swallows permission errors into false, violating "unknown result → don't
  prompt").
- No reliable task-creator attribution exists today, so any source hit marks the current
  record-less identity as an existing user.
- Manually opening onboarding via shortcut (`newUserOnboardingOpen`) bypasses this rule and appends
  a record on save.

## 5. Service interface (IOnboardingRecordService)

| Method                                | Behavior                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendRecord(deviceMid, entry)`      | create the file and fix deviceMid if absent; append if present; warn and rebuild on corruption; service completes the userId                  |
| `shouldOnboard(deviceMid)`            | trigger decision; writes existing_local_user when tasks exist (see §4)                                                                       |
| `getOnboardingEligibility(deviceMid)` | like `shouldOnboard`, also returns `{ shouldOnboard, recordFileExisted }` (whether the record file existed before deciding). UI distinguishes `auto_first_open` from `auto_identity_change` (file exists, no entry for this identity). |
| `dismissOnboarding(deviceMid)`        | write dismissed on closing first-run onboarding; no-op if answers exist                                                                     |
| `getRecords()`                        | read the whole file (for later upload)                                                                                                       |
| `clearRecords()`                      | delete the file (debug)                                                                                                                      |

The RPC exposure chain matches settingService: `ServiceChannels.OnboardingRecord` → descriptor →
`createLocalServices` registration → `RemoteServiceAccess` getter → UI hook.

### 5.1 Service connection for mobile remote workspaces

The remote workspace service collection must expose `onboarding-record`, same-origin as that
entry's settings/OAuth. Under R3, SSH/WSL/Docker and Server all forward through the Source Server
([R3 main spec §8.1](./architecture/r3-source-server-remote-architecture.md#81-权威表)); settings/OAuth
are Source-owned, so all four transports bridge to the Source's own record service — never borrow
the window Local Host's records, never build per-project record services or copy records.

```text
mobile creates remote task -> new workspace attachment -> mobile allowlist -> onboarding-record RPC
  SSH/WSL/Docker/Server -> Source's existing service -> Source identity (OAuth via provisioning), records and task index
```

`onboarding-record` is a mandatory channel in `RemoteWorkspaceRpcContract v1` and inside the
`web-remote-replayable` attachment allowlist; omitting it makes mobile calls time out, same effect
as a missing registration. (The historical failure was exactly this missing channel registration:
after mobile remounted Root, the call failed and the settings-based fallback wrongly prompted
onboarding. The fix only fixed service assembly; trigger rules, settings-failure fallback, Root
remount and the desktop-continuous / web-remote-replayable task transport semantics are
unchanged.)

Regression coverage: with records present but no settings occupation field, entering a remote
draft on mobile shows no onboarding; first-run users still get it, and closing stays closed after
reconnecting; the remote collection uses the Source's record service, never the desktop's. Service
assembly tests verify read/write routing and error propagation over real RPC; browser regression
uses the real onboarding component, service assembly and mobile allowlist, with isolated fixtures
for task entry and transport — not a substitute for real-device pairing and SSH/WSL/Docker
end-to-end acceptance.

- RPC regression: `packages/desktop/test/hostRemoteWorkspaceServices.test.ts`,
  `packages/desktop/test/windowHostAttachmentRpcPolicy.test.ts`.
- Browser candidate case (pending manual review):
  `packages/desktop/test/e2e/manual-review/pending/mobile-remote-onboarding.mjs`, run from the repo
  root with `pnpm exec tsx <case path>`.

## 6. UI integration (OccupationOnboarding.tsx)

- Onboarding action copy must be fully defined in both language packs, never falling back to raw
  translation keys: `start` "开始使用" / "Get started", `continue` "下一步" / "Next", `saving`
  "正在保存…" / "Saving…", `back` "返回" / "Back", `error` "保存失败，请重试。" / "Failed to
  save. Please try again.". Regression covers all five keys in both languages so later telemetry
  reuses valid button copy.

- Top navigation uses equal-width left/right columns with a centered progress column: back left,
  step progress center, close right, buttons vertically centered with symmetric margins; hiding
  back on the first step keeps its column so the progress does not move.

- Occupation option icons are 20px (`size-5`); the selected circle stays 16px.
- Skip and next buttons both use `text-ui-base` (default 14px).

- Layout: the desktop two-column layout gets a uniform 4px outer padding and column gap; the right
  illustration panel reuses the main-window rounding rules (Windows 5px, macOS 26+ 12px, older or
  unknown macOS 6px, other platforms 12px). The left occupation/mode/preference selection cards
  use the first-layer container rounding `rounded-xl`; per this page's design, next/back/skip/
  close buttons are also `rounded-xl` to match the cards — global default button rounding is not
  changed. The right hero covers a 1px theme border, follows the panel rounding, takes no layout
  space and receives no pointers. The hero uses a left-aligned brand layout: logo, title and
  subtitle share a left edge, the content group vertically centered, max width 640px. Panel side
  padding varies 64–72px with window width, top/bottom stays 32–72px, logo-to-title 40px,
  title-to-subtitle 24px. Narrow screens keep the single-column form and existing scroll bounds,
  no hero; short windows let the panel scroll. Hero copy uses its own type scale: title 24–48px by
  content width, semibold, 1.15 line height, single line; subtitle 16px / 26px line height with
  explicit sentence-per-line breaks for the two English sentences, naturally wrapping long lines
  on narrow windows, not scaling with UI font size; the title keeps the hero theme text color, the
  dark-mode subtitle uses a light blue-gray for contrast. Hero copy aligns with the site brand
  title: English "Simple, Fast, Vibe‑Ready!", Chinese “简单、迅捷、氛围十足！”; the subtitle covers
  multi-agent completion of complex goals and control from anywhere, in a short version fit for
  the onboarding panel. The content-group top reuses the initialization page's brand icon
  component (size, black gradient base, stroke and rounding), not inverted across themes; the
  onboarding page disables its entrance animation, the initialization page keeps it. The onboarding
  logo's black base and white Z stay still, adding only a faint white sheen sweep inside the 1px
  rounded border — ~120° tail, one revolution per 5 s, soft tail, no outer glow; hidden when
  reduced motion is on. The background uses only the welcome hero's blue theme colors (dark: deep
  blue-black and cyan-blue; light: ice-blue white and sky blue) with an independently implemented
  flowing WebGL light field (visually informed by Mesh Flow 6, not official preset code), keeping
  the existing flow field, opacity and speed, only swapping base colors and light-band RGB; no
  hero static glow or blend modes. Orbit lines removed. Main wave ~3 s per cycle; the background
  takes no pointers, runs only while the desktop panel is visible, at most 24 fps, rendered at
  most 960px on the long edge. Reduced motion freezes the frame; hidden pages pause; unmount
  releases GPU and listeners; WebGL unavailable or context lost falls back to the theme's static
  base color — never blocking onboarding. Acceptance covers desktop large screens, short windows
  and mobile widths in dark/light; content must not overflow or cover navigation.

- Display gating: `requested || (needsOnboarding === true && !dismissed)`;
  `needsOnboarding` is the async decision result. **The decision must never block the main UI
  indefinitely**: existing users (settings already has `onboardingOccupation`) enter the main UI
  without waiting; suspected first-run users wait at most 3 s. `appendRecord` also carries a 5 s
  timeout so a missing channel never leaves the save button spinning forever.
- Fallback decision semantics (2026-10 revision):
  - **3 s timeout → conservatively "no onboarding"**. The old implementation fell back to a
    settings-based decision, but the fallback closure evaluated at effect first run — when settings
    are necessarily unloaded (`useSettings` starts null) — so the fallback was always "need
    onboarding": on cold starts where the decision RPC exceeded 3 s (startup congestion, slow
    first tasks-index SQLite open, slow ws/relay), old users were wrongly prompted and the
    flash-appearance already counted as exposure telemetry before the real result arrived. A
    timeout means "result unknown" and must not disturb the user; the real result still applies
    when it arrives (a truly new user's onboarding just appears seconds later, main UI first).
  - **3 s release budget is separate from decision rounds**: reruns triggered by settings load or
    identity change only refresh the decision context and never re-grant main-UI blocking time.
    The deadline is established at the first pending round and shared across rounds; reruns only
    use the remaining budget, and exhaustion releases conservatively — total main-UI waiting never
    exceeds the 3 s cap set by the first round. Producing a decision result (real result /
    conservative release / failure fallback / user completing onboarding) ends the budget; once a
    result exists, later rounds' timeout fallbacks no longer apply and must not flip an already
    released main UI or an in-progress onboarding.
  - **Decision failure (rejection) or unavailable service → always conservatively "no onboarding"**
    (2026-10 second revision). The old settings-based fallback (`!onboardingOccupation`) judged
    never-onboarded existing users as needing onboarding — contradicting "existing users are never
    prompted" — and the settings snapshot at effect first run is necessarily unloaded, with past
    bugs prompting from stale snapshots. Failure means "unknown"; a truly new user at worst sees
    onboarding one startup later (same cost as timeout).
  - **Settings no longer participates in fallback decisions**: `settingsLoaded` /
    `onboardingOccupation` were removed from the trigger hook; hook dependencies narrowed to the
    record service, userId and deviceMid. Settings' `onboardingOccupation` remains only for the
    "existing users skip waiting" UI release (§6 gating) and recommendation content — no longer a
    source of truth for eligibility.
- Known limitation: hosts without the record service (home-only web views, pure render-test
  doubles) never auto-prompt (direct consequence of the conservative semantics); that is a service
  assembly gap (same class as the §5.1 mobile remote omission). The fix direction is wiring the
  same-origin record service, not a trigger-rule fallback; until then users can still open
  onboarding manually from settings.
- `save()`: after the existing settings update succeeds, call `appendRecord()`; append failure
  only warns — never blocks the onboarding flow or surfaces an error.
- Settings fields like `onboardingOccupation` are still written (the recommendation prompt pool
  depends on them), with semantics of "this user's most recent occupation choice".

## 6.5 Prefill and direct exit on reopening

- **Prefill**: manually opened onboarding (settings entry or shortcut) and re-triggered onboarding
  initialize the three pages from the userId's latest record answer (`getLatestEntry()`). Fields
  recorded null by a skipped page prefill defaults (occupation developer / default preferences); a
  record occupation outside the current list (list evolution) also falls to defaults. In coding
  mode, proactive memory always prefills off, even if previously enabled and saved in settings; in
  office mode it prefills from the latest answer, defaulting to on. If prefill data arrives after
  the user already interacted, it must not override their choices.
- **Re-completing onboarding**: this run's choices overwrite settings and the record, replacing
  preferences saved in settings or the last onboarding. Reopening in coding mode and saving
  directly also turns previously hand-enabled proactive memory off — intended behavior.
- **Direct exit**: the top-right X and ESC both exit — nothing saved, settings unchanged, a
  `dismissed` eligibility decision written, and auto-trigger never fires again. Manually opened
  from settings can still be closed anytime back to the previous view; identities with existing
  answers add no new decision when closing a manually opened onboarding.

## 7. Settings backfill (restoring preferences on account switch)

Settings are not per-user: after A answers, B triggering onboarding would push B's answers into
settings. So when a login-state change (or startup) decides "no onboarding needed", call
`syncSettingsFromRecord()` to backfill the current userId's **latest** record answer into settings'
`onboardingOccupation / proactiveSuggestionsEnabled / memoryEnabled`, switching recommendation
content. Rules:

- Backfill timing (CR-03 revision): **only after a runtime userId change** (account switch/login).
  Mount first-run (including null→id from async startup OAuth restore) only decides, never writes
  back — otherwise user-disabled recommendation/memory switches would be resurrected from the
  record on every startup.
- Manual edits write back to the record (CR-03 revision): the recommendation close button and the
  settings suggestion/memory toggles call `updateRecordPreferences()` on the current user's entry
  while updating settings (failure warns only). The record always equals "this user's latest
  preference", so backfill never overrides manual edits.
- Fields recorded null by skipped pages backfill conservative defaults (occupation `other`,
  preferences off), matching onboarding-skip settings writes.
- Record occupations are non-enum strings (the list evolves); backfill narrows via
  `appSettingsOccupationEnum`, unknown values landing on `other`.
- No settings change when the current user has no record; sync failure warns only.

## 7. Upload reservation (to implement once the server API is fixed)

Onboarding exposure and completion telemetry is a separate spec:
[Onboarding telemetry](monitoring/onboarding-telemetry.md). Its end-of-event choice snapshot
(including third-page skip checkbox states) is not the local record upload and does not change this
record's null-on-skip rules or `uploadState`. Telemetry uses work/code modes; the local
`interfaceMode` keeps office/coding; identity fields reuse the common telemetry user_id/device_mid.

- payload = entries with `uploadState === "pending"` + deviceMid; `decisions` are not uploaded;
- on upload success the corresponding entry becomes `uploaded`;
- trigger timing pending (startup backfill / post-login report).
