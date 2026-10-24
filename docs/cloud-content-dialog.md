# Shared content dialog and Hero assets

Scope: client shared components and Hero assets. Formal delivery integration and
banner semantics live in [marketing-touch-client.md](marketing-touch-client.md);
the ops backend is not included.

## Current implementation

Banner presentation supports the host visual message
`{channel:"zcode-cloud-hero-v1",type:"hover",instanceId,hovered:boolean}`, sent
only after ready and false when dynamic effects are reduced. It is not a business
action; the iframe stays unfocusable, receives no native pointer events, and
ignores in-package actions. Dialog Heroes do not receive this bridge and keep
native interaction. See the Marketing Touch banner hover bridge spec.

The close button uses a media-overlay palette independent of the Hero/App theme:
black 50% opacity background, white X, no border; hover deepens the background to
black 65%. It keeps its circular shape, original size, and focus/close/reporting
paths, adds no server field, and changes neither the Banner nor the global Dialog.

- `CloudContentDialog` is the shared display shell consuming title, description,
  hero, buttons, and actions. It is shared by Marketing Touch's standalone popup
  and the success result dialog.
- The App no longer provides a temporary mock entry or delivery RPC; the test
  server independently provides a valid payload and ZIP fixture.
- The Desktop local host downloads, verifies, safely unzips, and caches assets,
  serving them via randomized-lease loopback URLs; the iframe keeps
  `sandbox="allow-scripts"`.
- image/video/lottie/interactive_bundle are all implemented. Lottie uses the
  fixed 5.13.0 light canvas, loaded on demand.
- The App's bottom-left entry is wired to Marketing Touch; the success dialog
  takes the delivered `success_popup`, and the Hero ZIP comes from the
  server-granted URL/hash. The old Weekend banner/result-dialog adapters are
  deleted; the Hero construction fixture lives only in test/helpers and never
  enters the App.
- `mocks/weekendPlanResultDialog.zh-CN.json` is a **content template** without
  bundle metadata; the mock server injects the real ZIP fields to make it a valid
  HTTP response.

## Usage and verification

The App uses the Marketing Touch GET delivery; there is no "content mock" button
and no `CLOUD_CONTENT_MOCK_ORIGIN` read. CloudContentService only handles
readPublishedMedia / prepare / release for authorized assets and no longer
exposes status / load / clear debug RPCs.

Hero ZIP and HTML source assets are now maintained in a separate authoring
workspace; the old asset directory in the App repository was archived and removed
— see [asset authoring migration](weekend-banner-resource-bundle.md#2026-09-12-制作工作区迁移)
for the location and verification commands. The automated test server
`packages/desktop/scripts/cloud-content-mock.mjs` and its fixtures remain, used
only by tests or standalone runs, never wired into App startup.

Interface fixture tests: `node --test packages/desktop/scripts/cloud-content-mock.test.mjs`.
App verification uses `marketing-touch-delivery.test.ts`, asserting both that the
old entry is gone and that authorized ZIP/reporting flows work. The old
preview-panel-specific unit tests and E2E are retired; the history is recoverable
from git.

## v1 field contract

The authoritative definition is the Zod schema in
`packages/shared/src/cloudContent.ts`; UI types derive from it and no second wire
type is maintained.

| Field                     | Consumer and constraint                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| schemaVersion             | must be 1                                                                                             |
| id / revision             | non-empty content id (max 128 chars) / positive integer version; isolates dialog-instance async state |
| kind / locale             | campaign, feature, notice / zh-CN, en-US; kind never injects campaign business                        |
| dialog.title              | plain text, 1–500 characters                                                                          |
| dialog.description        | format, text; text up to 20,000 characters                                                            |
| dialog.hero               | four-kind union, see below                                                                            |
| dialog.buttons            | at most 4, unique ids; label up to 200 characters; variant is primary/secondary/link                  |
| button.actionId / actions | references must exist; at most 16 actions; only registered host handlers execute                      |

| Hero type          | Fields                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------- |
| image              | src, darkSrc?, alt, fit?                                                                     |
| video              | src, darkSrc?, poster, autoplay?, loop?, muted:true, fit?                                    |
| lottie             | src, darkSrc?, autoplay?, loop?, speed? (0.1–4), fallback?                                   |
| interactive_bundle | runtime:zcode-hero-sandbox-v1, bundle, viewport:{aspectRatio:"4:3"}, data, events, fallback? |

The bundle must contain `format:"zip"`, `url`, `entry`, `sha256` (64 lowercase hex);
`sizeBytes` is optional and, when present, must be a positive integer matching the
actual size. Server-side Marketing Touch has no size field; the actual byte caps
on download and expansion are still enforced. The HTTP mock uses computed
metadata — a placeholder hash must not pass validation.

`resolvedUrl` is **not a cloud field**; the shared schema strips it. It is set
only by a successful host prepare or an App-bundled trusted asset adapter. An
interactive Hero without resolvedUrl shows only fallback/placeholder and never
loads bundle.url directly.

`data` is a credential-free JSON object, serialized to at most 64,000 characters;
`events` is a display-event map with at most 16 entries. URLs allow absolute
HTTP(S) without username/password only; dev sources allow loopback HTTP, and
production assets must match the URL/hash granted by the host's verified
delivery.

### Description

- `plain_text`: displayed as plain text.
- `html`: simple HTML; supports p/br/b/strong/i/em/u/s/ul/ol/li/code/a/span/time
  plus h1–h6/blockquote/pre/hr/del/table/thead/tbody/tr/th/td.
- `markdown`: supports paragraphs, headings, emphasis, lists, quotes, code,
  links, and tables via the shared safe renderer; embedded HTML renders as text.
- The marketing-adapted `formattedTitle` / `formattedLabel` (UI-only fields) keep
  format/text and support the same three formats as description. Titles/buttons
  convert block nodes to spans; links are not interactive. Legacy string
  title/label calls stay compatible.
- Classes are kept and merged with default Tailwind classes; only compiled
  classes take effect; styles are filtered per the cloudDescriptionStyle
  property/value rules. id, event attributes, images, script, iframe, forms, and
  SVG are rejected; unsupported elements and their subtrees are dropped.
- Parsing goes through an inert template and rebuilds whitelisted React nodes;
  remote DOM is never inserted directly into the visible page. Depth caps at 32;
  over-limit falls back to plain text.
- Links keep HTTP(S) href/title only and open through the host open_external
  handler; without the capability they degrade to text.
- Default typography uses the client theme; allowed classes/styles can override.
  Weekend dynamic entitlements and times are escaped before composing HTML.

### Actions

close closes the current instance; dismiss_content closes after the injected
handler succeeds — formal account/revision frequency control is not implemented.
navigate accepts only model_settings/plugin_store/settings; copy_text,
open_external, and claim_plan all require host-injected capabilities — the shared
component never touches platform or business services directly.

Buttons render in payload order; a missing handler disables the button; a single
flight per instance; failures give feedback and are retryable; close is always
available. Copy success shows a host-localized label without changing the payload.
After close/reopen, old promises must not affect the new instance. Closing a
controlled dialog restores focus to the in-page opener that opened it.

## Architecture and timing

```text
App -> Marketing Touch GET -> DTO/schema -> authorized URL/hash
  -> prepare(bundle) -> download -> SHA-256 -> safe unzip -> host cache
  -> lease scoped URL -> shared Dialog -> sandbox iframe -> init -> ready
                              | title / HTML / buttons   | display interaction
                              v                          v
                         injected host handler        iframe-internal DOM

close -> invalidate this instance's requests -> destroy/remove iframe -> release lease
late old request -> release its lease, do not reopen the dialog
host exit -> cancel downloads -> close the asset HTTP -> release lease -> delete own cache directory
```

Main owns no asset download/unzip business. Services are injected through
ServiceCollection/RPC; the UI accesses them through hooks. Assets are unrelated
to workspace/task: they never land in the project directory, are never sent to a
remote workspace, and never start another Agent.

### Cache and resource URLs

The Desktop directory:

```text
<ZCode data base>/.zcode/v2/cache/content-bundles/<host-instance-uuid>/
  staging/<unique-attempt>/
  <sha256>/index.html
  <sha256>/.bundle.json
```

The normal user data base is the user directory; E2E uses the runner's isolated
directory. Each host owns its root exclusively; reopening the same host reuses it;
different hosts share no in-memory lease. **The cache does not promise reuse
across App restarts.** Normal exit deletes the host's own directory; crash
leftovers are not cleaned up by other active hosts.

- ZIP at most 8 MiB, expanded at most 32 MiB, single file at most 8 MiB, 128
  entries, cache budget 128 MiB.
- Downloads cap at 30 seconds with at most 3 redirects, validated per hop;
  actual bytes must match the declaration.
- Absolute paths, path traversal, backslashes, Windows reserved names, symlinks,
  duplicate paths/case conflicts, and in-package cache manifests are rejected.
- Separate staging with atomic promotion after full verification; a cache hit
  re-checks the manifest and file digests.
- acquire/read/release/clear are serialized inside the service; cleanup skips
  active leases and evicts by budget/LRU after release.
- HTTP listens only on a random 127.0.0.1 port with paths prefixed by an
  unpredictable lease, serving only manifest files read-only; after release the
  old URL returns 404.
- CSP forbids connect/frame/object/form; scripts run only inside the sandbox
  without same-origin; responses carry correct MIME and
  nosniff/no-referrer/no-store.
- yauzl stays an external Desktop runtime dependency to avoid ESM inlining its
  CommonJS require("fs") breaking startup; packaging checks include the module.

### Hero lifecycle and isolation

Fixed 4:3 Hero area, 480px dialog cap, narrow-screen adaptation, vertical
scrolling. Videos are muted/playsInline and pause when hidden/reduced-motion/
closed; Lottie is destroyed on close — JSON at most 2 MiB, 50,000 nodes, 40
levels, with external images, fonts, and expressions forbidden.

The interactive asset keeps the starfield, ticket, entrance, idle press, pointer
tilt, click flip, and Replay. After load it sends init
(instanceId/theme/locale/reducedMotion/data); 5 seconds without ready falls back
to fallback. Messages accept only the current contentWindow + instanceId +
channel; unknown display events are dropped. iframe display events never connect
to the business action dispatcher.

Entitlement icons use the user-supplied Lucide Gift SVG (three paths and one
rect), not the ◇ character. The SVG is inlined into the asset template and cloned
per entitlement row; 12×12px, stroke=currentColor, reusing the ticket-accent
theme color, aria-hidden=true; copy keeps using textContent — remote strings are
never executed as SVG/HTML.

Weekend Hero animation contract: the in-package JS is the sole owner of animation
state. Entrance cleanup removes is-entering when the entrance ends or is
interrupted by a click; the native Y-axis backface is hidden only during the
entrance, never permanently visibility:hidden; the front, native back, and
entrance backface reuse the same background color and ticket-notch mask. Replay
first cancels the previous animation round and press, then starts a new entrance;
fast repeated replays do not stack animations. When hidden or
reduced-motion, no idle RAF is scheduled and it resumes when visible again;
destroy cancels animations; resource messages accept only the parent.

```text
init/replay -> cancel old animation -> entering -> animationend -> idle
entering/idle -> click -> clear entrance state -> rotateY (same-color backface) -> idle
visibility=false/reducedMotion -> stop RAF; destroy -> stop all animation
```

This round does not redesign the starfield or change the marketing interface. The
existing init/data/theme protocol stays compatible; the App's plan display data
mapping is kept for now; pixel-identical rendering versus the original React Hero
is not claimed. Outputs are a new-directory ZIP with matching metadata; the old
package is kept — after the server uploads the new package, the new URL/hash must
be synced.

Delivery JSON fetch/validation failures follow Marketing Touch's failure policy;
an asset preparation failure still shows the validated title/description/buttons.
Runtime errors degrade the Hero without blocking close.

## Cross-platform and launch boundaries

The shared UI and App-bundled HTML are reusable by Desktop/Web/mobile; mobile
narrow screens use the same components. The App's temporary dev preview entry is
removed. Web/mobile **must not use the Desktop loopback URL**; unresolved remote
bundles use fallback/placeholder and the ZIP is never executed.

Real ZIP asset hosting for Web/mobile is not integrated; the Desktop delivery
client is wired to Marketing Touch, but the real backend still awaits joint
testing — Desktop E2E passing must not be described as an all-platform cloud
launch. desktop continuous / web remote replayable, owner/lease, workspaceIdentity,
and the Agent protocol are unchanged; the asset lease here is not a task owner
lease.

Production acceptance is separate: trusted HTTPS/CDN publishing auth, signing,
account isolation, delivery frequency control, gray release/rollback, and Web
asset hosting. SHA-256 only proves byte consistency, not publisher trust.

Windows/Linux/mobile real devices and human pixel-level acceptance were not done;
E2E stays pending. Archived Weekend Hero bundles (v1–v3, with SHA-256 records)
live in the resource authoring workspace archive; their example CDN URL, plan_id,
and asset_id need filling after upload and do not represent the current build
output.

The full phased plan and acceptance records are in
[cloud-content-dialog-plan.md](./cloud-content-dialog-plan.md).
