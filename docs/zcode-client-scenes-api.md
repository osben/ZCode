# ZCode Client Scenes API

## Goal

The App service layer registers the ZCode Client Scenes API so scene consumers read server-side scene
config through the unified `ApiClient` request exit, instead of hard-coding test domains or bypassing
the ZCode common-parameter injection.

## Request contract

- Method: `GET`; path: `/api/v1/client/scenes`; test environment example: `https://zcode.z.ai/api/v1/client/scenes`.
- The URL must be built with `buildRuntimeZCodeApiUrl(process.env, path)` so production, test and runtime endpoint overrides keep following the existing environment switching rules.
- Callers must use the injected `ApiClient`. `NodeApiClient` injects source common parameters, device id and request id when the request hits the current ZCode endpoint; callers must not hand-write those headers again.
- The endpoint takes no new query parameter or Authorization header.

## Response boundary

A successful response is `ClientSceneResponseBody<ClientSceneConfig[]>`: `{ code, msg, data }`. `data`
is a server-delivered scene array and may be empty. The Service layer does not interpret specific
scenes; each UI consumer matches only its own declared scene and option keys, and unknown config must
be ignored.

- `ClientSceneConfig`: `namespace`, `scene`, `options`; `created_at` / `updated_at` optional.
- `ClientSceneOption`: i18n `contents`; `prompts`, `items`, `templates` and the cascading-filter `refer` / `cascades` are optional per scene.
- `ClientSceneItem`: i18n `contents` / `labels`; `descs`, completion events, Lucide icon name, the compatibility-retained `imgs` and share links are optional per scene.
- `on_finish` and `img` may be absent or `null`; `imgs` and its `cn` / `en` are optional.

## Scope

The App service layer exposes a read-only query through the standalone `clientScenesService.list()`;
the service uses the unified `ApiClient` internally, and the UI never calls `fetch` or touches Host
endpoint constants.

Multiple React consumers in the Renderer read the same raw `ClientSceneConfig[]` through the shared
`useClientScenesResource()`. It uses SWR's renderer-memory cache with the currently injected
`IClientScenesService` instance as the authority isolation boundary: concurrent mounts on the same
Service instance issue a single `list()`; after a Service/Host attachment replacement a new cache key
is used and the old authority's result is not reused. The cache is not written to localStorage,
automation, off-peak or session persistence.

Template config is low-frequency data. A successful result is reused directly within a 10-minute dedupe
window; there is no polling, and window refocus or network recovery may let SWR revalidate outside the
window. With a cold start and no cache, consumers show loading; with a cache they show last-known-good
data at once and revalidate in the background if needed, never falling back to a skeleton. A network
error or `code !== 0` counts as a failed revalidation: the existing cache is kept; only a cold-start
failure degrades to an empty catalog, and it must not block manual creation entries of the Composer or
tasks.

On Desktop macOS, clicking the close button hides the main window instead of destroying it, so the
renderer and its memory cache stay alive. The shared resource layer must listen to Page Visibility:
only an actual `hidden -> visible` transition invalidates the current Scene cache and merges into one
forced revalidation by Service authority + SWR cache authority; a plain focus without hiding keeps the
10-minute throttle. A forced revalidation bypasses the dedupe window but keeps showing last-known-good
during the request and does not clear the existing catalog on failure. Web tabs and mobile browsers
resuming from background use the same semantics; a first-ever visible, a repeated hidden or a repeated
visible must not trigger an extra request.

`ConversationDraftSuggestedPromptsContainer` calls `clientScenesService.list()` once the current
workspace RPC is ready and maps `options.prompts.items` of `scene === "draft-suggestion"` to suggested
prompts; the old `ai-writing` is no longer a fallback for this entry. Mapping details and failure
boundaries: `docs/ui/conversation-draft-suggested-prompts.md`.

`AutomationsSection` and `OffPeakNewTaskEntry` also consume two explicit scenes:

- `scheduled-task`: a prompt item's `labels` is the title and `contents` the description/instructions; `defaults.cronExpr` back-references `options.cronExpr.items`, and the cron takes only the referenced item's `contents`. The UI first validates Service legality and the Automation editor's lossless round trip, then shows it with the local schedule describer, ignoring cron item `labels`.
- `off-peak-task`: a prompt item's `labels` is the title. Only the New task home card description prefers `descs` per locale, falling back to `contents` when the language is missing or blank; the Automations card description and the creation draft's instructions always take `contents`. Automations shows only the remote catalog and shows "no templates available" for an empty catalog; the New task home appends local Customize after the remote mapping, unless the remote catalog already contains Customize. Customize's stable title and description go through intl at render time only via `offPeak.newTask.template.customize.title` / `.description`; the catalog mapping keeps no second cn/en copy.

For `draft-suggestion`, `scheduled-task` and `off-peak-task`, a prompt item's `img` is a Lucide
canonical name (kebab-case, e.g. `file-text`) and must no longer be requested as an image URL. The home
and Automations panels load the SVG dynamically by name, using `currentColor` to inherit the semantic
text color of the icon slot; when `img` is missing, blank, not a name in the current Lucide version, or
module loading fails, they fall back to the entry's existing local Lucide semantic icon. `imgs` takes
no part in icon selection for these entries.

```text
ClientSceneItem.img
  -> trim + Lucide canonical name allowlist
     -> known name ----> dynamic Lucide SVG ----> currentColor
     -> missing/unknown/load failure ----------> surface-local Lucide fallback
```

In both scenes, a prompt item whose `labels.cn` / `labels.en` are both empty must be rejected and not
enter a card or creation form.

Both only provide candidate templates. A click copies only the current locale's plain string into the
form draft; scene/item/default metadata never enters automation or off-peak persistence. A request
failure must not block manual creation.

```text
React consumer mount / workspace attachment change
  -> useClientScenesResource(service authority)
     -> cache hit --------------------------> return last-known-good scenes at once
     -> cold miss -> SWR dedupe -> clientScenesService.list()
                                  -> Host ApiClient + ZCode common params
                                  -> GET /api/v1/client/scenes
  <- success: update shared memory cache -> each consumer maps its own scene independently
  <- failure: warm cache keeps the old value; cold cache returns an empty catalog
  -> Service authority switched: a late result of the old key must not enter the new key
```

Desktop/Web/mobile remote session, stream and workspace state chains are unchanged. Desktop local
workspaces and desktop-attached remote workspaces use the desktop Host's app-global scenes service;
server remote uses the server-authoritative service.
