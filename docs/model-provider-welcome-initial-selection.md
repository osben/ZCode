# Model Provider Welcome Initial Selection Policy

## Intent

WelcomeScreen hosts both account OAuth login and API Key configuration entries with different user
intent: OAuth login means the user wants account plan entitlements; the API Key entry means the user
wants to configure a same-brand API Key. The connection choice writes family mode / selected key and
controls which model group the input model menu shows for that family, so initialization must
happen only under an explicit entry intent.

The Model Provider settings left navigation selects only a provider family or custom provider;
Start Plan / Coding Plan / Team Plan / API Key are connection types within a family, switched by the
detail pane's connection menu. The WelcomeScreen entry must decide both the left family and the
right connection type. After login, provider, personal plan entitlement, Start Plan fallback
entitlement, and team plan results refresh asynchronously; selecting on the settings page's first
frame would mis-select API Key or the personal Coding Plan.

## Rules

WelcomeScreen does not wait for plan queries and keeps the current app-entry pacing. It only writes
a one-shot initial selection intent consumed by the Model Provider settings page.

### Navigation and connection-type layering

- The left side navigation shows only provider families / custom providers: Z.ai, BigModel, other
  builtin providers, custom providers.
- The right "connection type" menu shows switchable connections within the family: Individual Plan
  (个人), Team Plan (团队, one entry per retrieved team plan), API Key.
- Start Plan is not shown as a logged-out connection type; it enters the connection menu only after
  login confirms Start Plan entitlement exists and no personal/team plan entitlement does.
- Multiple team Coding Plans do not create multiple side navigation entries; they are options in the
  right connection menu.
- Selecting a family renders the detail pane per that family's selected connection type: Plan Card
  or API Key form.

### OAuth login entry

When the user logs in via WelcomeScreen Z.ai or BigModel OAuth, the settings page first selects that
family's side navigation entry, then waits for the connection-type state to be decidable and selects
once, by priority:

1. Personal Coding Plan: personal Coding Plan entitlement exists.
2. Team Coding Plan: the first team entry in the team plan result.
3. Start Plan: Start Plan entitlement exists.
4. Personal Coding Plan fallback when no entitlement exists at all.

Full state matrix:

| Start | Personal Coding | Team Coding | Post-login `modelProviderFamilySelectedKeys[family]` |
| ----- | --------------- | ----------- | ---------------------------------------------------- |
| yes   | yes             | yes         | Personal Coding                                      |
| yes   | yes             | no          | Personal Coding                                      |
| yes   | no              | yes         | Team Coding                                          |
| yes   | no              | no          | Start                                                |
| no    | yes             | yes         | Personal Coding                                      |
| no    | yes             | no          | Personal Coding                                      |
| no    | no              | yes         | Team Coding                                          |
| no    | no              | no          | Personal Coding fallback                             |

When several team plans are available, use the first team with `subscribed === true` in backend
order; with several projects in that team, use `teamProjects[0]`, then fall back to the
product-level `projectId` and `"0"`, keeping the selected key stable.

The Start Plan query depends on the personal Coding Plan result: Start Plan is decidable only after
the personal plan is confirmed to have no entitlement, team plans are unavailable or decided, and
the Start Plan fallback query completes.

The settings page has no independent connection-type initialization write-back. On reopen or when
Team Plan returns asynchronously, it must first restore the historical
`modelProviderFamilySelectedKeys[family]`; only a manual user switch in the settings page writes new
`modelProviderFamilyModes[family]` and `modelProviderFamilySelectedKeys[family]`.

Post-reconnect automatic connection updates are owned by the Root OAuth callback. OAuth jumps to the
unified login entry while the settings page may stay mounted, go to background, or remount, so the
post-login background selected-key refresh must write to shared settings, independent of the
settings page's mount state.

After a successful OAuth callback the Root must also best-effort refresh the current account's
connection settings in the background: after the callback chain refreshes provider keys, read the
latest provider, personal Coding/Start entitlement, and BigModel Team pricing, then write
`modelProviderFamilyModes[family]` and `modelProviderFamilySelectedKeys[family]` by the same
priority. A failed background write must not roll back login state but is logged; the settings page
only reads the written historical selected key and never re-applies initial selection intent.

### API Key entry

When the user picks Z.ai or BigModel via the WelcomeScreen API Key entry, the settings page selects
that family's side navigation entry and selects API Key in the connection menu directly,
independent of Start/personal/team entitlements.

API Key login writes only `modelProviderFamilyModes[family] = "apiKey"`; the input box and settings
page show the family's API Key entry directly from API Key mode, without depending on the OAuth
selected key.

## Boundaries

- The initial selection intent is consumed once; later entitlement refreshes never override a
  manual user selection.
- Opening the settings page normally does not write WelcomeScreen intent: keep the existing
  selection, saved family mode and fallback behavior; never re-select the right connection type by
  entitlement priority.
- The entry intent is scoped to the current family only — no cross-selection between Z.ai and
  BigModel.
