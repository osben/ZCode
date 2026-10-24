# Port of 3.16.3 small UI and project features

Status: draft, implemented on branch `claude/port-3163-ui-small`.
Source of truth for behavior: the shipped 3.16.3 desktop bundle (minified, read-only) — upstream 3.16.3 source is not published yet, so every identifier and string below is taken from the bundle. Upstream baseline: 3.16.2 (`3c5b2276`, `fork-upstream-base.json`). Bundle paths are relative to the extracted `asar/out` directory: `renderer/assets/styles-CQuzX8si.js` (app components, OAuth hook, Root workspace actions), `renderer/assets/IntlProvider-Bw7hoRlp.js` (locale dictionaries), `host/index.js` (host project repository, zod schemas, onboarding record service).

## 1. OAuth login: "Browser didn't open? Copy login link"

Bundle behavior: `useOAuth` (`Bxt`) keeps an `authorizeUrl` state — set to the `authorizeUrl` returned by `startOAuthWithPolling` after the stale-attempt check and before `openExternal`; cleared at `startLogin` start, on `cancel`, `reset`, `setOAuthError`, `setOAuthSuccess`, and in the `catch`. The login entry renders, inside the `waiting` block after the Cancel button and only when a URL is present, a row with `login.oauth.browserNotOpened` and a `<button data-testid="oauth-copy-login-link">`. The copy handler: no URL or unavailable `navigator.clipboard.writeText` → `login.oauth.copyLinkFailed`; otherwise `writeText(url)` → `login.oauth.copyLinkSuccess`; rejection → `login.oauth.copyLinkFailed`. Feedback is a toast.

Locale (bundle values):

- `login.oauth.browserNotOpened`: en `Browser didn't open?`, zh-CN `浏览器没打开？`
- `login.oauth.copyLoginLink`: en `Copy login link`, zh-CN `复制登录链接`
- `login.oauth.copyLinkSuccess`: en `Copied. Paste and open it in your browser.`, zh-CN `复制成功，请到浏览器中粘贴并打开`
- `login.oauth.copyLinkFailed`: en `Could not copy the login link. Please try again.`, zh-CN `复制登录链接失败，请重试`

### Rules

- The copied value is the same authorization URL the app opens with `openExternal`. It contains OAuth state, so it is copied but never logged or sent to telemetry (telemetry keeps the hostname only, as today).
- The link is available only while `status === "waiting"` and a URL exists. Any terminal transition (cancel, error, success, reset, retry) clears it, so a stale link is never shown.
- Copy uses `navigator.clipboard.writeText`, matching other UI copy actions in this repo (`ChatErrorBanner`, `GitActionMenu`). It is not a `window.zcode` call.

### Interfaces

- `useOAuth()` returns an additional `authorizeUrl: string | null`.
- `TID_OAUTH_COPY_LOGIN_LINK = "oauth-copy-login-link"` in `packages/shared/src/test-ids.ts`.

### Acceptance

1. Starting a login shows the waiting state with the copy row and button.
2. Clicking the button writes the authorization URL to the clipboard and shows the success toast.
3. A clipboard failure shows the failure toast and keeps the waiting state.
4. Cancel, error, success or reset removes the copy row.
5. Without a URL (no pending start), no copy row is rendered.

## 2. Help menu: "Copy device MID"

Bundle behavior: the item sits inside the `isDesktop` section of `WorkspaceHelpMenuButton`, after "Export logs" and before "Resource manager"; lucide `Copy` icon; no test id. Handler: `platform.getDeviceId()`; empty value or unavailable clipboard → error toast; otherwise `writeText(id)` and a success toast.

Locale (bundle values):

- `workspaceHeader.help.copyDeviceMid`: en `Copy device MID`, zh-CN `复制设备 MID`
- `workspaceHeader.help.deviceMidCopied`: en `Device MID copied`, zh-CN `设备 MID 已复制`
- `workspaceHeader.help.deviceMidCopyFailed`: en `Could not copy device MID. Check clipboard access and try again.`, zh-CN `复制设备 MID 失败，请检查剪贴板权限后重试。`

### Rules

- The MID is the device id from `IPlatformService.getDeviceId()`, the same id the app uses for telemetry and onboarding. It is shown only in the clipboard and never logged.
- Desktop only (`isDesktop`). Web does not render the item.

### Acceptance

1. On desktop, the Help menu shows "Copy device MID" between "Export logs" and "Resource manager".
2. Selecting it writes `platform.getDeviceId()` to the clipboard and shows "Device MID copied".
3. An empty id or clipboard failure shows "Could not copy device MID..." and writes nothing.
4. On web (`isDesktop=false`), the item is absent.

## 3. Project open: `reuseExistingRoot` and `project.invalid-directory-open`

Bundle behavior:

- Host schema (`host/index.js`): `reuseExistingRoot: z.boolean().optional()` on the project save input. A refine rejects it unless: exactly one root, `hostId` absent or `"local"`, and the only keys are `roots`, `hostId`, `reuseExistingRoot`. Error: `project.invalid-directory-open`.
- Host repository `saveProject`, after the remote-root assertion and before the restore check: if `reuseExistingRoot` is set and the host is not local, or the call targets an existing project (`id`/`restoreProjectId`), or there is not exactly one root, throw `project.invalid-directory-open`; otherwise look for a non-deleted project on this host whose root path matches the directory (primary root first, then position, then id). If one exists, return it; no duplicate project is created.
- Renderer `handleSelectProject` (`useRootWorkspaceActions`), desktop only: `if (!services.projectService) throw "project.service-unavailable"`, then `saveProject({ roots: [path], reuseExistingRoot: true })` before `activateOrSetWorkspace`. The returned id is passed as `{ projectId }` to the draft (`startDraftInWorkspace(path, undefined, { projectId })`). Errors set the workspace action error; `project.invalid-directory-open` is shown as the raw error like other save failures.

### Rules

- Opening a directory as a workspace on desktop is idempotent per (host, root path): the same directory always resolves to one project id.
- The option is never used for remote hosts, multi-root saves, or edits.

### Interfaces

- `SaveProjectInput.reuseExistingRoot?: boolean` (`packages/services/src/project-storage/contract.ts`).
- Project service zod schema (`packages/services/src/project/index.ts`) accepts the field with the same refine as upstream, error `project.invalid-directory-open`.

### Acceptance

1. Saving `{roots:[p], reuseExistingRoot:true}` twice returns the same project id.
2. The same call with two roots, a non-local host, or extra keys (e.g. `name`) is rejected with `project.invalid-directory-open`.
3. Renderer: on desktop, opening a folder calls save with `reuseExistingRoot` first, then the draft uses the returned project id.

## 4. Onboarding eligibility: `getOnboardingEligibility`

Bundle behavior: the host record service returns `{ shouldOnboard, recordFileExisted }`; `shouldOnboard(deviceMid)` is kept and delegates. `useOnboardingTrigger` calls `getOnboardingEligibility(deviceMid)` after `claimAnonymousRecord` and returns a third value `source`: `shouldOnboard ? (recordFileExisted ? "auto_identity_change" : "auto_first_open") : null`. The bundle passes it to an onboarding entry-source consumer, which does not exist in this fork. Remote forwarding: the host service is registered through the generic remote service collection (`packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`); no method-specific forwarding is needed.

### Rules

- `recordFileExisted` reports whether `onboarding-record.json` existed before the decision. It is informational; eligibility is unchanged.
- Failure, timeout and missing-service paths keep the conservative "do not onboard" behavior of the existing hook.

### Interfaces

- `IOnboardingRecordService.getOnboardingEligibility(deviceMid): Promise<{ shouldOnboard: boolean; recordFileExisted: boolean }>`.
- `useOnboardingTrigger` returns `[needsOnboarding, markOnboarded, source]`, where `source: "auto_first_open" | "auto_identity_change" | null`. Existing callers ignore it.

### Acceptance

1. No record file and no local task: eligibility `{shouldOnboard:true, recordFileExisted:false}`.
2. Record file with an identity entry: `{shouldOnboard:false, recordFileExisted:true}`.
3. Hook: `source` is `auto_first_open` for a fresh user and `auto_identity_change` when a record file exists but has no entry for the current identity; `null` when not onboarding.

## 5. Plugin scope labels and browse buttons

Bundle behavior:

- Five keys are absent from the 3.16.3 dictionary and all code: `settings.plugins.scope.inheritedUser`, `settings.plugins.scope.userDefault`, `settings.plugins.scope.workspaceOverride`, `settings.plugin.plugins.browse`, `settings.plugins.store.browseAll`.
- Installed plugin rows (`renderPluginRows`) no longer read `plugin.enabledSource` and render no scope badge (the only `enabledSource` reference in the chunk is the toggle mutation). `SettingsScopeBadge` stays for MCP and config options. The workspace-scope hint `settings.plugins.scope.workspaceHint` stays, as do `settings.plugins.scope.restoreUserDefault`, `settings.plugins.scope.restored`.
- Plugin list header (user scope) and the empty state use `chat.plugins.browseMarketplace` ("Browse plugin marketplace") instead of `settings.plugin.plugins.browse`.
- Plugin store page: detail-view back button `data-testid="plugin-store-detail-back"`, label `settings.plugins.store.back` ("Back"), leading back icon. Manage view header: icon-only ghost button `data-testid="plugin-store-manage-back"`, `aria-label` `project.back`, then the `manageInstalled` heading. The `plugin-store-browse-all` button is gone. The pending manual-review suites under `packages/desktop/test/e2e/plugins/manual-review/pending` (`plugin-management-ui-market`, `plugin-management-recoverable-failures`, `plugin-management-discovery-presentation`) use `plugin-store-manage-back`; none references `plugin-store-browse-all`.

### Rules

- Plugin rows do not state their scope. The scope is still changed by the existing enable controls and the workspace hint.
- Only the browse labels and buttons change; no behavior of the add menu changes.

### Acceptance

1. Installed plugin rows show no "User default" / "Inherits User default" / "Workspace override" label.
2. The user-scope header and empty state show "Browse plugin marketplace".
3. Store detail view shows "Back" and returns to the store.
4. Manage view shows an icon-only back button (`plugin-store-manage-back`) and no browse-all button.

## Locale delta (en-US, zh-CN; uk-UA kept in step)

Method: the bundle dictionaries were evaluated from the IntlProvider chunk and compared with upstream 3.16.2 `en-US.ts`/`zh-CN.ts` (`3c5b2276`) and with the fork's current files.

Added in 3.16.3 (upstream-level), in this port:

- `login.oauth.browserNotOpened`, `login.oauth.copyLoginLink`, `login.oauth.copyLinkSuccess`, `login.oauth.copyLinkFailed` (feature 1)
- `workspaceHeader.help.copyDeviceMid`, `workspaceHeader.help.deviceMidCopied`, `workspaceHeader.help.deviceMidCopyFailed` (feature 2)

Removed in 3.16.3 (upstream-level), removed here (nothing else references them):

- `settings.plugins.scope.inheritedUser`, `settings.plugins.scope.userDefault`, `settings.plugins.scope.workspaceOverride`, `settings.plugin.plugins.browse`, `settings.plugins.store.browseAll` (feature 5)

Reported, not ported (outside this task):

- Added: `remote.error.authenticationUnsupported`, `remote.error.authenticationUnsupported.reason`, `remote.error.platformUnsupported`, `remote.error.platformUnsupported.reason`, `remote.error.workspaceDirectoryUnresponsive`, `remote.error.workspaceDirectoryUnresponsive.reason`, `remote.phase.workspace`, `remote.phaseSub.workspaceReading`, `manualClaimPlan.claim.failure.captcha`, `chat.error.action.retryCaptcha`, `chat.captcha.verifyFailed`.
- Changed text (en and zh-CN): `zcode.error.providerBusiness.3007`, `zcode.error.modelSuspiciousEmpty` (captcha wording); zh-CN `settings.plugins.store.menu.disable` changed from `禁用` to `停用`.
- Fork gap: upstream 3.16.2 keys absent from the fork's en-US (for example `archives.count`, `taskGroup.reorder`); the fork uses its own variants. Not changed here.

## Reconciling with the real 3.16.3 source

- Key names and text for features 1 and 2 must match the source. Keys of the same name must be merged, not duplicated.
- Upstream's `handleSelectProject` also has a second parameter that skips the open-window check (`activateOrSetWorkspace`) and a stale-request counter. Neither is ported; compare with upstream when merging.
- `useOnboardingTrigger`'s `source` is wired to an entry-source consumer in upstream; here it is returned but unused.
- Plugin rows and the store page were restructured in upstream. Only the labels and buttons listed above are ported. Check any UI layout differences on the next sync.

## Not ported

- Onboarding entry-source telemetry (`entrySource` consumer, `auto_first_open` / `auto_identity_change` events): the fork has no matching consumer; the hook exposes `source` only.
- `handleSelectProject`'s second parameter and stale-request counter, and the `project.service-unavailable` guard beyond the existing `projectService` check: these change renderer control flow and are not needed for `reuseExistingRoot`.
- The captcha features, remote error and phase keys listed above: separate features.
