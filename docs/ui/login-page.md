# Login Page

At startup, if no OAuth user was restored and there is no usable model provider config, Root shows
`WelcomeScreen`.

All in-app login entries converge to `WelcomeScreen` and reuse the OAuth and API Key flow of `LoginPanel`,
so manual login, startup guide and model provider connection do not become several state machines:

- Startup auto guide: `WelcomeScreen`, opened by the provider-availability guard.
- Manual login entry: `WelcomeScreen`, opened from the settings page or the workspace shell login action.
- Model provider connection: `loginEntryRequest` opens `WelcomeScreen` and auto-starts OAuth for the given
  provider.
- Login content container: `bg-background`, `border-popover-border`, `shadow-md`.

After the OAuth callback completes, an API Key is saved, or "跳过" (Skip) at the bottom of the API Key form is
clicked, the login page closes and returns to the normal Root route.

When the user clicks "跳过" or enters the empty-draft home from another entry with no usable model, the home
must show the existing `modelConfigMissing` error banner, offering upgrade and model-config entries. The banner
only projects local provider readiness; it triggers no Agent start, deferred draft session creation, network
probe or warm-up failure retry, and clears automatically after a valid provider/model is saved and the draft
model hydration completes.

When the empty draft also shows the workspace / Git context header, the error banner must be an independent
surface above the input card shell, not embedded in the rounded card wrapping the context header and editor,
with a fixed `mb-6` (24px) gap between banner and input card. The visual order is fixed: "error banner ->
independent spacing -> choose workspace / Git branch -> input box". Desktop and mobile Web use the same DOM
order and container levels; responsive layout may change only wrapping and density, never move the banner
below the workspace entry or merge it back into the input card shell.

When the input is empty, the API Key login form shows a `Get API Key` external-link entry on the right; once
the user has typed or auto-filled an API Key the entry hides, so the link does not take up key-editing space.
The link target follows the currently selected provider:

- Z.ai: `https://z.ai/manage-apikey/apikey-list`
- BigModel: `https://bigmodel.cn/apikey/platform`

On first entry to the API Key form, the provider default is decided only by the App's resolved `locale`:
Simplified Chinese (`zh-CN`) defaults to BigModel and English (`en-US`) to Z.ai. `locale` already includes the
resolved "follow system" language preference, so the form does not separately read the system language or
provider history. The rule only initializes the form; after the user switches provider manually, a language
broadcast must not overwrite the current selection.

The external link must open through `IPlatformService.openExternal()`, keeping desktop shell and Web
`window.open` behavior consistent. The input keeps password type and Enter-to-submit; the link button only
jumps to get a key and takes no part in the save flow.

The cancel button of the API Key login form shows a "跳过" link button at the bottom. Skip writes only the
selected provider's `providerFamilyDomain`, `providerFamilyDomainUpdatedAt` and `providerFamilyDomainMigrated`
to confirm the Z.ai / BigModel runtime domain; it does not save an API Key, does not trigger the API Key login
success event and does not modify `modelProviderFamilyModes`.

After the startup auto guide completes there is a direct path for new users: if no workspace is currently open,
Root uses the conversation descriptor injected by Main and, when needed, idempotently ensures
`<dataBaseDir>/.zcode/workspace/default` exists through `fileService.ensureConversationWorkspace()`. This
workspace provides a real cwd while the UI stays "no project selected", so the user can chat directly without
passing through the project picker. If the user skips login and still has no usable model, that draft home
shows the `modelConfigMissing` banner per the rule above.

Manual login and model provider connection, on completion, only close `WelcomeScreen` and return to the
original screen; no default workspace is created.
