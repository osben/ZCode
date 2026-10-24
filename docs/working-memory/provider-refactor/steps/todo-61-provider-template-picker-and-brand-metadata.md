# Todo 61: Provider Template Picker and Brand Metadata Closeout

> Status: Completed
>
> Date: 2026-09-02
>
> Background: the product branch `feat/provider-ux-refactor` added a provider directory, logos and sidebar styles on
> top of an earlier Provider implementation. This Todo does not merge that branch; it re-implements the confirmed
> product intent on the current Provider Template, Provider Config Overlay and Registry architecture.

## 1. Goal

Without restoring the old Model Catalog or adding a second Provider candidate source, deliver these Settings
experiences:

- a unified "Add Supplier" entry at the top;
- the entry opens a Provider Template picker page in the right detail area;
- the picker consumes the target Host's `ProviderSettingsView.providerTemplates` directly;
- create a Personal Provider from a Template, or a pure custom Provider with no Template;
- Template names support Chinese and English;
- a created Personal Provider gets a stable, unique, editable `label`;
- the Provider Logo is decided by the Effective Provider Config, not by a second product list the Renderer keeps by
  Provider ID;
- keep the existing Provider settings layout, scrolling, dragging, Account Provider and delete fallback behavior.

Impact: primary owner is the Provider Config/Template domain and the target Host's Settings Facade; primary UI is the
model settings Provider navigation, detail title and the new `ProviderTemplatePicker`; downstream are the
Bundled/Remote Built-in Release, Active/LKG, Personal creation and Desktop/Web/phone settings pages. Invariants:
Registry identity, Account pages, Model Rule priority, drag/delete fallback and model execution semantics are
unchanged. Main risks: the Release shell version not switched atomically, Renderer copying brand facts, name dedup
bypassing the Host atomic update, an unknown remote Logo key causing config rejection.

## 2. Terms and boundaries

### 2.1 Catalog is not restored

The feature does not use "Catalog" as a domain name (the old Model Catalog carried model capability and runtime facts
and left the Provider main chain). Names: UI "Add Supplier"; component `ProviderTemplatePicker`; page state
`template-picker`; data source `ProviderSettingsView.providerTemplates`. Forbidden: `ProviderCatalog` /
`CatalogProvider` domain types; Catalog Service, Source or Repository; a Renderer-maintained candidate list or order
table by Provider ID; supplementing Template facts from the old Model Catalog, Preset or remote product config. Sole
chain: `ProviderSettingsView.providerTemplates` -> `ProviderTemplatePicker` -> select `templateId` ->
`createPersonalProvider({ templateId, label })` -> Personal Provider Config.

### 2.2 Domain shell principle

When a domain object has its own metadata beyond the Config Overlay, a domain shell carries the metadata and the
Overlay; the domain object is not simply the Overlay, and domain metadata does not pollute the generic Overlay. This
round applies the principle only to `ProviderTemplate` (normal Built-in Providers have no new metadata and are not
mechanically wrapped; Model Config Rule structure and priority are unchanged):

```ts
interface ProviderTemplate {
  readonly nameMap: ProviderTemplateNameMap;
  readonly config: ProviderConfig;
}
```

`ProviderTemplateMap` is `templateId -> ProviderTemplate { nameMap, config: ProviderConfig Overlay }` (was
`templateId -> ProviderConfig`). `modelConfigRules` (`matchRules`, `templateModelRules`, `providerModelRules`) are not
moved into the Template shell: they jointly express a clear rule priority and moving Template/Provider exact Rules
into domain shells would hide that `matchRules` Overlay still precedes them. Because the physical value structure of
`providerTemplates` changed in a breaking way, the Bundled Release, Remote Release codec, Active/LKG cache and test
fixtures switch atomically to the same new Schema Version. The old structure was unreleased: no dual-read, old-shell
importer or runtime shape guessing; old clients and new content are isolated by the existing app-version/Schema-Version
boundary.

## 3. Template multilingual names

The Template shell adds `nameMap` keyed by the current app Locale BCP 47 identifier:

```ts
type ProviderTemplateNameMap = Readonly<{
  readonly "zh-CN"?: string;
  readonly "en-US"?: string;
}>;
```

Built-in content should provide both supported languages; the current Release Schema accepts only `zh-CN` and
`en-US` and adding a Locale must bump the Schema/Release Version (old clients never guess new keys). Resolution
order: `nameMap[current locale]` if present and non-empty; else `nameMap["en-US"]`; else `templateId`. `nameMap`
belongs only to the Template — not in `ProviderConfig`, no new `label_map`; the picker uses it directly and Renderer
keeps no Provider ID to i18n message map.

## 4. Creation and name dedup

The Template name is the name seed at creation, not a dynamic name afterwards: current UI Locale -> resolve the name
seed from `Template.nameMap` -> `createPersonalProvider({ templateId, label: seed })` -> Config Service re-checks the
name under the Personal Config update lock -> generates a unique label and writes the Personal Provider Overlay.

- The UI `label` is only a seed and cannot bypass server-side dedup; dedup completes in the same atomic update as
  Personal Provider creation; `initialConfig` must not carry `label` (so the generic Overlay cannot bypass the dedup
  entry).
- On conflict keep the existing `Name`, `Name 2`, `Name 3` semantics; concurrent creation never yields identical
  labels.
- After creation `label` is stable Personal config: switching UI language does not rename; later user renames write
  the same Personal `label`; Template config updates do not overwrite an already-created Provider's `label`.
- A pure custom Provider still uses the localized "New supplier" seed through the same atomic dedup entry.

## 5. Template picker interaction

### 5.1 Entry and page

An "Add Supplier" button sits at the top of the settings description area near the refresh button; clicking it keeps
the left Provider navigation and switches the right detail to `ProviderTemplatePicker`; a back button restores the
detail before entering; after successful creation go straight to the new Provider's detail; no new narrow-screen
stacked split (keep the current left-right split and independent left/right scrolling, do not rewrite settings page
height and overflow layers); no Template search this round.

### 5.2 Template cards

Use the current Built-in Provider Template publish order (no UI Provider ID order table); the first item or an
explicit area provides a "Custom supplier" entry; the whole card is clickable with a uniform enter arrow on the
right; cards are exactly 64px high; the name is a single line, truncated with an ellipsis when over the available
width and the full name is shown in a hover tooltip; no `overflow-wrap: anywhere` splitting normal words; Logo with
uniform size and padding, name takes the remaining width; Desktop, Web and phone layouts verified with long
Chinese/English names.

## 6. Other confirmed Settings changes

Provider sidebar adjusts only the Logo size it needs (not the product branch's row height, selected state or status
styles wholesale); the status dot reads Provider `executable` (executable green, non-executable gray); no restored
Provider top-level `enabled` or Provider Switch; no "Enabled" status text; "Add Model" moves to the right of the
"Model list" title; after deleting a Provider the current navigation fallback is kept (no adjacent-Provider
selection); a failed Provider delete keeps the current selection; brand names in the picker are published by the
Template `nameMap` (`Z.AI` with capital `AI`); created Providers and Account Providers keep reading `label` from their
own Effective Provider Config and never read back the Template `nameMap`; except for explicitly localized names the
English UI uses official English brand names; the Renderer does not translate brands by ID.

## 7. Logo configuration and bundled assets

The Logo stays in `ProviderConfig`, not duplicated in the Template shell: `ProviderConfig` already carries display
facts like `label` and `visibility`, and the Logo is likewise a display fact of the final Provider. A Template
provides its default Logo through its inner `config`; Account/Built-in Providers provide Logo through their own
Provider Config; a Personal Overlay can inherit it. All settings pages read only the Effective Provider Config, never
inferring a Logo by Provider ID.

### 7.1 Facts at the time

`ProviderConfig.logoUrl` only flowed through Schema, Overlay, Resolver and legacy config migration — the settings page
did not consume it; the account UI's Z.AI / BigModel icons come from an OAuth brand icon helper; ordinary Personal
Providers and Template-created Providers showed a generic Package icon; the product branch added several 80x80 PNGs
and a Renderer `Provider ID -> Logo import` map listing Template, Account and pay-as-you-go API Providers together —
duplicating Provider identity and brand ownership facts, not adopted as is. In the branch's asset list Moonshot,
MiniMax, Xiaomi, OpenAI, Anthropic, xAI and DeepSeek have traceable sources; Z.AI is marked user-provided; the Alibaba
asset came from a third-party GitHub repo and cannot be treated as official; its PNGs are opaque square canvases with
unverified light/dark behavior, padding and size consistency. So this round deletes the Renderer Provider ID Logo map
and replaces the unconsumed, URL-carrier-named `ProviderConfig.logoUrl` directly with the structured
`ProviderConfig.logo`; the structure was unreleased so no `logoUrl -> logo` compat reading or URL conversion, and the
old Personal importer does not migrate `logoUrl`. The association between a Provider and a brand asset is declared
once in Provider Config.

### 7.2 Config and asset structure

```ts
type ProviderLogoRef = Readonly<{
  readonly type: "builtin";
  readonly key: string;
}>;

interface ProviderConfigInput {
  readonly logo?: ProviderLogoRef | null;
}
```

Although the type is an extensible discriminated union, this round's Schema accepts only `type: "builtin"` (no URL,
uploaded file or Data URL). `key` is an open string — not enumerated in the Provider Schema and not part of Provider
integrity or executability validation. The UI's generic asset resolver turns `key` into a bundled asset usable on
Desktop/Web; the resolver keeps no Provider order, name, Template membership or Account product logic.

```text
Effective Provider Config.logo -> Built-in Logo Resolver
   ├─ known key -> pick the bundled asset by theme
   └─ unknown/missing -> generic Package icon
```

Official Config may publish a `key` the client does not yet know; it must parse, save and enter the Registry normally,
the older client only falling back to the generic icon (no error, no loss of executability) and showing the Logo once
the client bundles an asset for that key. This forward tolerance is for unknown `key` only, not unknown `type`: the
current client supports only `type="builtin"`, and a future URL/uploaded-file type needs a formal Release
Schema/client compatibility upgrade (old clients do not guess new resource protocols).

A Personal Provider created from a Template keeps inheriting the Template `config.logo` through `templateId` (the
Logo is not copied into the Personal Overlay), so a later remote Template revision updating the Logo reaches
instances with no explicit Logo override while the Personal `label` stays unaffected. Account Providers, Family
pay-as-you-go API Providers and other Built-in Providers declare the Logo key in their own Provider Config (several
Providers may reuse one key). `logo` is a display config item of the common Provider Config Overlay: the Personal
Schema may explicitly override a known Built-in key or clear it with `null` (falling back to the generic icon), but
this round's UI offers no edit entry; a pure custom Provider writes no `logo` at creation and uses the generic
Package icon. Settings View, the cross-process protocol and form View Models project the same `logo` structure from
the Effective Provider Config as is — no `resolvedLogoUrl`, `providerBrand` or Provider ID map; the resource URL is
computed only in the final UI resolver from `logo.key + current theme`.

### 7.3 Light/dark theme

Provider Config declares one `key`, no `lightLogoKey` / `darkLogoKey`; whether a brand needs two theme assets is a
bundled-resource implementation detail:

```ts
interface BuiltinProviderLogoAsset {
  readonly light: string;
  readonly dark?: string;
}
```

Brand color Logos clear in both themes provide only `light` and are reused; when the official source provides
light/dark versions, or a monochrome mark lacks contrast in a theme, ship both; the UI picks `dark ?? light` by the
current theme; no CSS filter, inversion or recoloring of brand assets; an SVG loaded as `<img>` cannot rely on
external `currentColor`, so ship files with explicit colors or per-theme versions. The `system` theme is first
resolved by the existing theme state into actual light/dark before choosing an asset (the Resolver creates no third
theme state). A Logo expressing the same information as the adjacent Provider name is decorative: empty `alt` and
hidden from assistive technology to avoid double reading.

### 7.4 Personal and Account Provider boundary

An Account Provider is not a Provider Template and must not get a `templateId` just to reuse a Logo; it gets its Logo
from its own Built-in Provider Config. The existing OAuth icon helper is no longer the brand fact source of the
Provider settings page (OAuth/Login may keep its own icon use). A pure custom Provider with no Logo uses the generic
Package icon; no upload/URL/pick-built-in Logo UI this round (extend `ProviderLogoRef` when truly needed).

### 7.5 First bundled asset set

First built-in keys: `zai`, `bigmodel`, `moonshot-kimi`, `minimax`, `deepseek`, `alibaba-model-studio`,
`xiaomi-mimo`, `openai`, `anthropic`, `xai`. Asset principles: prefer the brand's official SVG, else official
PNG/JPEG; assets need not share source format or size, and first-batch bitmaps may be scaled without cropping or
altering the artwork, preserving any alpha channel; the UI uses a uniform square container, `object-contain` and
consistent padding for visual size; Z.AI and BigModel reuse the brand assets already in the repo for formal
login/account UI; Moonshot Kimi uses the official `MoonshotAI/Branding-Guide` resources (single asset reused in both
themes); MiniMax uses the square asset of the official brand pack; DeepSeek uses the brand mark published by its
official organization (confirm trademark authorization before release); Alibaba Model Studio does not use the
third-party-GitHub image from the product branch but official Alibaba Cloud / Bailian assets (China and international
Templates reuse one key); Xiaomi MiMo uses its official platform asset; OpenAI and Anthropic use assets from their
official sites (a monochrome Anthropic SVG needs explicit light/dark files — an SVG with `currentColor` as a plain
`<img>` will not inherit the page color); xAI uses official site or organization assets; the product branch's source
list stays an audit lead but assets are re-included only after source and theme-fit review, never copied wholesale.
Each bundled asset records brand, source URL, retrieval date, file format, transparency and theme use. A missing Logo,
failed resource load or a remote config referencing an unknown key all fall back to the generic icon.

### 7.6 Display surfaces

| Surface                                   | Data source                                  | Behavior this round                                       |
| ----------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| Provider left navigation                  | Effective Provider Config                    | Show Provider Logo; missing or unknown key falls back     |
| Provider detail title                     | Effective Provider Config                    | Same Logo Resolver as navigation                          |
| Provider Template picker                  | Template `config.logo`                       | Show the Template baseline Logo                           |
| Account Provider detail                   | Account Provider's Effective Provider Config | No more inferring the Z.AI/BigModel Logo by Provider ID   |
| Welcome/OAuth login entry                 | The login product's own brand resources      | Kept for now, never the Provider Logo fact source         |
| Model selector, session messages, task list | Out of scope                               | No new Logo surface just to "unify the brand"             |

All bundled Logos live in the UI resource boundary shared by Desktop and Web, used by one Resolver. The Renderer may
keep a `logo key -> bundled asset` table, but it only loads resources and contains no Provider ID, name, order,
Template membership or Account product rule.

## 8. Not included

No merge or cherry-pick of `feat/provider-ux-refactor`; no Catalog data layer; no change to Account Provider, Start
Plan, Individual Plan or Team Plan page structure; no removal or simplification of plan intro, purchase cards, price,
Quota and Usage; no change to Account entitlement, Access, Registry integrity or model execution semantics; no Model
Config Rule movement or priority change (Match/Template/Provider/Personal); no change to Provider/Model drag
semantics; no change to overall settings page width, height or double-column scrolling; no Template search.

## 9. Implementation outline

Update the Provider Template, Provider Config and settings page Design and the Feature Graph's Template/Settings
nodes and code seeds first (domain shell, name, Logo state ownership, display surfaces); bump the Built-in Release
Schema Version and add tests for Provider Template Schema, JSON round-trip, Bundled/Remote decode, Active/LKG and name
resolution first; upgrade `ProviderTemplateMap` values to `ProviderTemplate`; update Built-in JSON to
`{ nameMap, config }` per Template; update Resolver, Config Service, Facade and Settings View Template projection;
creation takes an explicit name seed and dedups atomically on the server; settings interaction E2E first, then the
top entry, Template picker, back and post-creation landing; delete the unreleased `logoUrl`, use `logo`, assemble the
first bundled assets with the theme-aware resolver (no compat importer); adjust sidebar Logo size, status dot and
"Add Model" position; clean up the old dropdown Template entry and the Renderer Provider ID name/Logo/order tables;
a full review confirms no Catalog, Provider enabled or Account page regression.

## 10. Acceptance

### Config / Provider

- Provider Template shell strict parsing and JSON round-trip; Bundled, Remote, Active/LKG and fixtures share the one
  new Release Schema Version, no compat reading of the old Template Map shape.
- `nameMap` current language, English and `templateId` fallback; Template `config` keeps using the formal Provider
  Config Overlay Schema; Model Config Rule structure and resolution priority unchanged.
- Same-name creation atomically yields a stable suffix on the server; concurrent creation cannot yield identical
  `label`; `initialConfig.label` cannot bypass dedup; switching language after creation does not change the Personal
  `label`.
- `logo` strictly accepts the current `builtin` structure but `key` is not a closed enum; `logo` Overlay, `null`
  clearing, JSON round-trip and Effective Provider projection correct; a Template Logo update affects later Effective
  Config without copying or rewriting the Personal `label`; Settings View/Protocol carry the `logo` reference, not a
  resolved resource URL; an unknown Logo key produces no integrity error and does not affect Registry/executable; an
  unknown Logo type stays rejected by the current strict Schema (not confused with the UI fallback for unknown keys).

### UI / E2E

- The top entry opens the Template picker on the right; back restores the original detail; Template publish order
  unchanged; no search entry; Chinese/English Template names correct; single-line long names truncated with a hover
  tooltip, Logo and enter arrow aligned.
- Known Logo, unknown Logo fallback, missing Logo fallback and light/dark selection correct; the `system` theme picks
  the right asset after resolving, single-asset brands are reused in both themes; the Logo does not make assistive
  technology read the name twice.
- Template creation and pure custom creation both land on the new Provider's detail; the Provider status dot strictly
  reflects `executable`; Add Model sits at the right of the title; deleting the current Provider keeps the existing
  fallback; Account Provider pages and plan cards have no behavior or visual regression; Desktop, Web, phone, Zai
  Light, Zai Dark and keyboard covered.
- Verification: Provider, Provider Node, Services and UI directed unit tests; affected Desktop E2E; `pnpm typecheck`;
  `pnpm lint`; `pnpm test:unit`; `git diff --check`. Conventional Commit with the real Agent session trailer (never
  guess a missing Session ID).

## 11. Outcome

- Built-in Release Schema is v3 and Built-in revision 8; Bundled, Remote, Active/LKG and test fixtures switch
  atomically to the same Template shell.
- Template picker, back, creation from Template/pure custom, post-creation landing, Host atomic name dedup and
  concurrent dedup are implemented.
- `logoUrl` is removed from the formal Provider Config, replaced by the open-key `logo: { type: "builtin", key }`; an
  unknown key or resource load failure falls back to the generic icon only, never affecting Provider integrity or
  execution.
- The first brand assets are bundled in the shared UI resource boundary, with source, attribution and scaling recorded
  in `model-provider-logo-sources.json`; current assets are reused in both themes and the Resolver keeps an optional
  dark slot.
- Provider navigation, detail title and Template cards consume the Logo from the Effective Provider Config/Template
  config uniformly; the Renderer has no Provider ID to brand map.
- The top "Add Supplier" entry and the "Add Model" entry beside the title are done; the old sidebar Template dropdown
  and candidates are deleted; Account pages and the delete fallback are unchanged.

Verification: Provider, Provider Node, Services, Server and UI directed unit tests: 22 files, 388 passed;
`pnpm typecheck`, `pnpm --filter @zcode/desktop typecheck:e2e` passed; `pnpm lint` passed (pre-existing warnings
only); full Unit: 13,071 passed, 25 skipped, plus 2 pre-existing failures unrelated to this Todo (E2E CLI seed env var
count and a pre-push hook command assertion); Desktop E2E built the app but the Samantha environment lacks
`xvfb-run`, so WebdriverIO could not create a Chrome session and no case-level result exists; changed-file format
check and `git diff --check` passed.
