# Todo 65: Provider Settings Dogfood Issues and Template UX Closeout

> Status: done
>
> Date: 2026-09-02
>
> Source: MacBook Air hands-on testing, plus visual comparison with the `feat/provider-ux-refactor` product branch.
>
> Prerequisites: Todo 55, 60, 61, 62, 63 done. This Todo does not change state ownership of Provider Template, Account Overlay, Registry, Model Selection or Option Spec; it fixes confirmed call omissions and settings-page UX regressions.

## 1. Goal

Four problems with hands-on evidence:

1. Start Plan and Team Plan connectivity tests lack the required `reasoningLevel`.
2. The Provider Template selection page did not fully inherit the valid visual intent of the product branch.
3. An empty custom Provider group wrongly shows a dash.
4. When Provider configuration fails, raw Schema issues flood the right detail area.

Two main chains stay unchanged:

```text
ProviderSettingsView.providerTemplates
        -> ProviderTemplatePicker
        -> createPersonalProvider({ templateId })
        -> Personal Provider Config

Effective Provider / Model Registry
        -> Active Model
        -> Provider Connectivity Request
```

The product branch is a visual and interaction reference only; do not bring back the old Provider Catalog, old Built-in candidate assembly or old Family/API Key special cases.

## 2. Account Provider connectivity test

### 2.1 Confirmed problem

On the MacBook Air, Start Plan and Team Plan reached the model list but the connectivity test failed with:

```text
Reasoning level is required for <providerId>/<modelId>
```

The request was already on the formal Model chain; the caller did not provide `reasoningLevel` explicitly for models declaring a Reasoning Option. It is not a missing plan, Provider or credential.

### 2.2 Target behavior

The test keeps using the formal Registry and Active Model and does not special-case Start, Individual, Team or specific model IDs. Per Todo 60 every Active Model in the Registry has a complete Reasoning Spec; a missing one is an upstream config integrity error, not a normal branch.

```text
Active Model.optionSpecs.reasoningLevel -> pass values[0] explicitly
```

- `values` stays ordered low to high; `values[0]` is the lowest usable level and is not equivalent to the string `disabled`.
- No `reasoningLevelPolicy` or Provider special branch.
- ModelFactory only validates and assembles; it does not silently fill execution Options for the caller.
- The test explicitly passes `min(5000, optionSpecs.maxOutputTokens.max)`, not relying on a ModelFactory fallback.
- Headers such as `x-zcode-session-type` still come from the formal Access/request assembly chain; the settings page must not copy them.

### 2.3 Tests

- With Reasoning Spec: the test sends `values[0]`; if the lowest level is not `disabled`, still the first item.
- Without Reasoning Spec: Effective Model Config is incomplete and the model must not enter the Registry.
- Start Plan, Team Plan and ordinary API Key Providers share the same connectivity logic.
- Failures show the real error of the formal Model request, with no Provider-specific error classification.

## 3. Provider Template selection page

### 3.1 Reference boundary

The `feat/provider-ux-refactor` visuals may be referenced, but the branch is built on the old Provider domain; do not copy components or business state.

Allowed: compact quiet card hierarchy; a clearer top "Add provider" entry; trailing arrow; coordinated Logo, name, spacing and hover; empty groups take no space.

Forbidden: `ProviderCatalog` or any Catalog domain type; Renderer assembling candidates, logos, names or ordering by Provider ID; old Built-in Provider creation logic; Provider top-level `enabled`; old Account API, Family API Key or Provider-ID specialization; a search box; replacing the Provider Logo with a drag handle on hover; unverified state and responsive code from the product branch.

### 3.2 Card spec

Templates and "create custom provider" share one card skeleton:

- strictly fixed height `64px` (no `min-height`, no growth with name length);
- two columns on Desktop, one column at narrow widths;
- `rounded-lg`; quiet background and border by default, stronger on Hover/Focus;
- horizontal padding about `16px`; card gap about `8px`;
- Logo slot about `36px`, `object-contain`, no cropping; Logo-to-name gap about `12px`;
- regular UI font size, medium weight;
- name strictly single-line, truncated, full name in a Tooltip;
- trailing `ChevronRight`;
- keyboard, `focus-visible` and disabled state kept;
- the outer two-pane container border token is not changed.

### 3.3 Template display names

Published display names stay short instead of relying on dynamic card height. Target calibration:

| Current long name                    | Target short name       |
| ------------------------------------ | ----------------------- |
| Moonshot Kimi                        | Kimi                    |
| Alibaba Model Studio (China)         | Alibaba Cloud (China)   |
| Alibaba Model Studio (International) | Alibaba Cloud (Global)  |
| 阿里云百炼（中国）                   | 阿里云百炼（中国）      |
| 阿里云百炼（国际）                   | 阿里云百炼（国际）      |
| Xiaomi MiMo                          | Xiaomi MiMo / 小米 MiMo |

`Z.AI API`, `BigModel API`, `MiniMax`, `DeepSeek`, `OpenAI`, `Anthropic` and `xAI` keep their short official names. Only Template `nameMap` changes; never `templateId`, Provider ID, API Schema or Registry identity.

### 3.4 Top entry and surroundings

- Keep the Template selection flow in the right detail area and the left Provider navigation.
- The top description, refresh and "Add provider" button regain a sensible width, order and spacing; "Add provider" is a clear primary action.
- Do not widen the whole Provider settings page, rewrite the stable independent left/right scrolling, or change the outer two-pane border token (revisit only if a clear hierarchy problem is still observable).

## 4. Empty group and error feedback

- With no Personal Provider: do not render the "custom providers" group, no `-` placeholder; top "Add provider" stays usable. After the first Personal Provider is created, show the group title and members normally.
- The user-visible banner shows one concise summary, for example `创建供应商失败：个人供应商配置格式无效` (creating the provider failed: personal provider config format is invalid). Full Zod issues go to the log through the UI Logger. Never render the raw issue array in the banner; no extra Toast or error classification.

## 5. Unreleased config boundary

The Provider top-level `enabled` seen on the MacBook Air is unreleased development config. The formal Schema already removed it, so: no Schema version bump, no `enabled` migrator, no tolerant read in the strict Schema, no dual-read. Clean the Air's development Personal Provider Config before hands-on testing. Do not reintroduce Provider `enabled` because of that old file.

## 6. Verification

Automated: Provider Settings / Template Picker and Provider Connectivity targeted tests; Template create, name, Logo, failure feedback and empty-group interaction tests; Start/Team connectivity Reasoning Option regression; Desktop E2E for Template Picker open, Template Provider create, custom Provider create, back and error feedback; `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `git diff --check`.

MacBook Air acceptance (current HEAD dev build, recording SHA, launch command and key results; static tests cannot replace it): clean the old Personal Provider Config; with no Personal Provider confirm no empty group or dash; check the top entry, two-column fixed-height cards, Logo, single-line names, truncation Tooltip, trailing arrow, Hover and keyboard Focus; create two Providers from the same Template (normal de-duplication, enters detail); create a pure custom Provider; simulate creation failure (only a concise bottom banner, details in the log); run connectivity tests for Start Plan `glm-5.3-flash` and Team Plan `GLM-5.3` / `GLM-5.3-Flash` (no `reasoningLevel` failure; if still failing keep the real server error and trace logs); check Light/Dark, zh/en and narrow windows (card height constant, no horizontal scroll).

## 7. Completion criteria

- Start/Team connectivity tests explicitly use Reasoning `values[0]`.
- Template Picker uses the formal `providerTemplates` source with the compact experience; cards are strictly single-line and fixed-height.
- Empty Personal Provider group is not rendered; the error banner no longer expands raw Schema issues; outer two-pane border unchanged.
- No search, Catalog, Provider `enabled`, Provider-ID specialization or second state fact added.

## 8. Outcome

- Provider Connectivity reads `values[0]` from the Active Model's ordered Reasoning Spec and explicitly sends `min(5000, maxOutputTokens.max)`; no plan, Provider ID or model ID branch.
- Template Picker keeps `providerTemplates` as the only source with fixed `64px` cards, two columns, Logo, single-line truncation Tooltip, trailing arrow and a clear top entry.
- Empty Personal Provider group is not rendered; the creation error banner shows a summary and full issues go to the UI Logger.
- Targeted UI/Service tests pass; MacBook Pro Settings UI E2E (7) and Coding Plan E2E including Start/Team connectivity (18) pass. The MacBook Air old-config cleanup and manual visual acceptance are environment operations, not a substitute gate for code correctness.
- Review found no return of Catalog types, Provider `enabled`, Provider-ID specialization or a second connectivity error classification.
