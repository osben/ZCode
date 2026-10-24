# `/` and `$` Panel Bundled Skill Bilingual Descriptions

Official bundled skills ship with the CLI via official plugins and surface in two composer entries: the `/` slash panel (enabled skills as candidates, inserting `$skill`) and the `$` skill mention panel. Their descriptions were mixed Chinese/English and did not follow the UI language.

Rules:

- Localized zh-CN/en-US descriptions apply to official bundled skills only in the `/` and `$` candidate panels. User-defined, third-party, Agent-runtime-injected skills and the CLI `zcode skills` output stay as-is.
- Both panels share one localization helper so the copy cannot drift. Skills without a localized entry keep the server-returned `description`; without any description, the existing scope fallback applies.

Design:

- Helper input: `name`, `description`, `path`, `scope`, optional `pluginName`, current `Locale`. It localizes only when the skill is an official bundled plugin skill: `scope === "plugin"` with `pluginName` in the official bundled plugin set, or a path inside the official plugin cache. The copy table stores `zh-CN` / `en-US` descriptions keyed by skill `name`.
- Entry points: `buildSkillSuggestions()` in `packages/ui/src/slashCommandHelpers.ts` (takes the current locale) and the mention provider `packages/ui/src/mentions/providers/skillsMentionProvider.ts` (locale from `useZCodeIntl()`, also for the source label).

Non-goals: `SKILL.md` body and frontmatter parsing, `@zcode/protocol` / `@zcode/contracts` / `ISkillsService` parameters, model-visible skill selection metadata, and skill name/path/enabled/ordering/filter rules are unchanged.

Verification: unit tests for `slashCommandHelpers` and `skillsMentionProvider` covering bundled-skill descriptions under zh-CN and en-US locales.
