# Todo 62: Provider Template UX Review Closeout

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.
>
> Desktop graphical E2E debt is closed out by Todo 78.

> Status: done (Desktop E2E not run on Linux without Xvfb; rerun on a machine with a graphical environment).
>
> Date: 2026-09-02
>
> Prerequisite: Todo 61 delivered the Provider Template domain shell, selection page, brand metadata and packaged logos. This Todo closes confirmed review findings only and does not change ownership of Provider, Template, Overlay, Registry or Model Config Rule state.

## 1. Goal

1. Every built-in Provider logo uses a square asset (the Alibaba Cloud horizontal wordmark is replaced).
2. Template creation failure gives explicit feedback inside the Provider detail area.
3. The Reasoning Level ordered-enum editor becomes compact tags.
4. Real Built-in Template creation and brand display get interaction verification.

The single main chain stays:

```text
Provider Template
├─ nameMap
└─ config: Provider Config Overlay
          |
          v
createPersonalProvider
          |
          v
Personal Provider Config
          |
          v
Effective Provider / Registry
```

No new Catalog, brand Service, Provider-ID product mapping, logo downloader or second error-notification system.

## 2. Built-in logo square-asset contract

### 2.1 Requirements

Every packaged asset behind `ProviderConfig.logo.type = "builtin"` must:

- have a square canvas or SVG `viewBox` (`1:1`);
- be a brand mark suited to an icon slot, not a horizontal wordmark with full brand text;
- keep rendering in the unified square container with `object-contain`, no stretching or cropping;
- prefer the vendor's official SVG, otherwise the official transparent PNG;
- keep its source recorded in `model-provider-logo-sources.json`;
- fall back to the generic Provider icon for a missing or unknown remote logo key, without affecting config parsing, integrity or execution.

Mechanical validation covers every packaged built-in asset: PNG intrinsic width equals height; SVG has a square `viewBox` or equivalent intrinsic size. A square CSS container alone is not validation.

### 2.2 Alibaba asset

`model-provider-alibaba-model-studio.svg` was a roughly `183.8 × 22.45` horizontal `Alibaba Cloud` wordmark (about `3.4px` tall in a `28 × 28` slot). Replacement rules:

- package the official square Alibaba Cloud (or Model Studio) brand mark;
- the China and International Templates may share one resource key;
- do not crop or redraw the mark from the wordmark;
- check clarity and visual size in Zai Light and Zai Dark.

Names:

```text
zh-CN: 阿里云百炼（中国） / 阿里云百炼（国际）
en-US: Alibaba Model Studio (China) / Alibaba Model Studio (International)
```

The service is Model Studio/DashScope, so "Alibaba Cloud" alone is too broad; using the main brand mark does not require dropping the product name.

### 2.3 Other names

- `Z.AI` keeps `AI` uppercase.
- BigModel keeps the official English brand name.
- The Moonshot Template name is `Moonshot Kimi` in both languages.
- Other Templates keep the current official English brand name; the Renderer never translates by Provider ID.

## 3. Template creation feedback

`handleCreateProvider` used to log failures only. Target behavior:

```text
click Template / create custom provider
              |
              v
   Host atomically creates Personal Provider
              |
      +-------+-------+
      |               |
   success          failure
      |               |
 open new Provider   stay on Template page,
 detail page         show failure banner
```

- Failure feedback reuses the existing banner style and queue at the bottom of the Provider settings detail area, with an error icon and the real error message.
- No second Toast at page top, window level or inside a Template card.
- On failure the page stays operable; retry or go back.
- Success enters the new Provider detail with no extra success message.
- Logging stays via `packages/ui/src/logger.ts` but never replaces user feedback.

## 4. Reasoning Level editor compaction

Reasoning Level `values` stays an ordered array from low to high; only interaction density changes (no change to structure, parsing, defaults or Runtime semantics).

- Level tags are about `28px` high with reduced horizontal padding, gap and delete-button footprint (was min `36px` frame).
- The delete control is muted by default and clear on hover, focus or edit state.
- Click-to-edit, add, delete, drag sorting and keyboard operation are kept; `Alt + Left/Right` is the keyboard alternative for drag sorting, with no extra shortcut copy.
- Personal Override border semantics follow the existing boolean/config field style; no "default/modified" text.
- The at-least-one-value constraint and duplicate handling are unchanged.

Editor tests must pin the compact size class, the edit-state size and delete-button accessibility, not only name themselves "compact tags".

## 5. Automation

Failing tests first.

- Logo: every built-in logo satisfies the square contract; Alibaba no longer references a wordmark; known/unknown/missing key and load-failure behavior unchanged; Light/Dark selection and single-asset fallback stay correct; Template card, Provider navigation and detail title read the same structured `logo` fact.
- Template creation (Desktop E2E, real clicks, no SSR static HTML substitute): click a Built-in Template and land in the new Provider detail; the new Provider inherits Template Endpoint, API Schema, model members and Logo; the name seed follows the current language and the Host atomically de-duplicates; pure custom Provider creation stays covered; injected creation failure shows the bottom banner, supports retry and keeps the landing page.
- Reasoning editor: compact tags, edit state, add, delete, drag and `Alt + Left/Right`; order changes write straight into the current Draft with no snap-back-then-jump; zh/en, keyboard, Light/Dark and narrow widths do not overflow.

## 6. Non-goals

- Reasoning `values[0]` stays the lowest level.
- No `reasoningLevelPolicy` or other policy abstraction.
- No change to Provider Template, Personal Overlay or Registry resolution priority.
- No Template search; no change to the Account Provider page or plan cards.
- No user-uploaded or remote-URL logos.
- No restoration of Provider `enabled` or a settings-page Provider Switch.
- No handling of unrelated repo-wide test baselines.

## 7. Outcome

### 7.1 Logo and names

- Mechanical logo validation added (PNG intrinsic size, SVG `viewBox`/intrinsic size, all must be `1:1`).
- The Alibaba wordmark is replaced with the square mark used by the official Alibaba Cloud GitHub organization, packaged as an `80 × 80` transparent PNG; source, owner and normalization stay in `model-provider-logo-sources.json`.
- Moonshot Template name is `Moonshot Kimi` in both languages.
- Built-in Config revision bumped from `8` to `9` so the name update flows through publish and refresh.

### 7.2 Template creation feedback

- Template and pure-custom entries await the same Host creation Promise.
- On failure the Template page stays and the Provider detail bottom banner shows the real error with a retry action. `ModelProviderSection` still logs and also returns the error to the interaction layer.
- A real-click interaction test pins the failure banner and retry; Desktop E2E asserts the Built-in DeepSeek Template create path (Endpoint, Schema, model order, Logo).

### 7.3 Reasoning Level editor

- Tags are about `28px` high with tighter spacing, edit input and delete button; delete shows on hover/focus only, semantics and accessible name unchanged.
- The old test file extension did not match the Vitest include and was never collected; the new test really covers compact size, keyboard sorting, drag, edit, add, delete and Personal Override.

## 8. Verification state

- Provider/UI targeted tests (5 files, 15 tests), `pnpm --filter @zcode/ui exec tsc --noEmit`, `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint` (existing warnings only), `oxfmt --check` on changed files and `git diff --check` passed.
- Repo-wide `pnpm fmt:check` was blocked by existing invalid HTML in `docs/electron` and a read failure on `apps/zcode-cli/tests/gb2312.js`.
- `pnpm test:unit:affected` escalated to full unit: 2 failures (an existing pre-push `mise-run` assertion and an E2E CLI Config constant-count assertion), unrelated to this Todo.
- Desktop settings E2E: app and Agent builds succeeded, but Linux lacked `xvfb-run`, so Chromedriver could not create a graphical session before any case ran (environment block, not an assertion failure). Rerun on a graphical machine or CI is still open.
