# Todo 41: Built-in Provider Featured Model and Property Refresh

> Status: Completed
>
> Evidence: [`builtin-provider-model-evidence-2026-08.md`](../research/builtin-provider-model-evidence-2026-08.md)
>
> Later correction: this Todo's judgment that MiniMax M3's official Endpoint was unconfirmed and default-off was
> overturned by the current official model-call docs; the final conclusion and revision 4 are in
> [`Todo 43`](./todo-43-models-api-evidence-and-minimax-m3-correction.md).

## 1. Goal

Based on 2026-08 vendor sites, search findings and confirmed ZCode product facts, upgrade
`config/provider/zcode-builtin.json` to revision 3: add current featured/unique models, correct confirmed
capabilities, express default enabled with Provider-Model Exact Rules, and make the physical Provider member order
match the enabled block. The result is deliberately conservative: unverified guesses are never written as enabled; a
separate model-verification API calibrates later.

## 2. Impact

Change classes: `option-source` (Built-in Provider Map and Built-in Model Config Rules); `draft-default` (Effective
Model defaults seen when adding/editing models in settings); `validation` (Registry integrity, Adapter
compatibility, media/request capability checks); `persistence` (release revision changes; Personal Overlay storage
unchanged).

```text
Built-in revision 3 (Provider members / initial order, Model Config Rules / exact enabled)
  -> Account Overlay -> Personal Overlay -> Effective Provider + Effective Model Config -> Registry -> Active Model -> Adapter
```

Session Selection, queue, Compact, Memory, Subagent, Desktop continuous, Mobile replayable and workspace identity are
unchanged; Active Model still freezes the Effective Model Config at creation. Implementation seeds:
`config/provider/zcode-builtin.json`, `packages/provider-node/test/zcode-builtin-integrity.test.ts`,
`docs/working-memory/provider-refactor/design/registry/zcode-builtin-provider-config.md`,
`docs/working-memory/provider-refactor/research/account-provider-and-builtin-config-review.md`. No state ownership or
async chain change was found.

## 3. Decisions

1. Normal Account API `glm-5.3` stays Text-only; "no error" is not vision evidence.
2. Plan Providers keep providing Image/Video for their actual members through Provider-scoped Match Rules.
3. Individual/Team add `GLM-5.3`; fixed order is 5.3, 5.3 Flash, 5.2, 5-Turbo.
4. Start members stay constrained by Account upstream; not statically widened.
5. Add Kimi K2.7 Code and Qwen 3.8 Max/Flash; add MiMo v2.5 Audio static facts.
6. MiniMax M3 was then treated as an unconfirmed candidate and default-off (corrected by Todo 43; not a current
   maintenance basis).
7. Default enabled uses the existing `provider-model` Exact Rule; no new priority, sorter or third Rule kind.
8. `supportsStructuredOutput` rename belongs to Todo 39; this round only corrects facts conservatively under the
   "strict JSON Schema" meaning, without the field migration.

## 4. Acceptance (test first; revision 2 must fail)

Real Built-in integrity test: revision is 3; member order and Plan Image/Video for the four Individual/Team
Providers; normal API 5.3 Text-only, 5.3 Flash Image/Video; each vendor's featured members exist with correct key
context/max output/media properties; each Provider's enabled models form a contiguous prefix of `builtinModelIds`;
replaced/alias/unproven candidates default disabled; every Built-in member has an explicit enabled from that
Provider's Exact Rule; after access material is supplied the Resolver still reports zero issues and the Registry
member order matches the file. No modelId/Provider ID hardcode in production code. Checks: `pnpm --filter
@zcode/provider-node test` and typecheck, `pnpm --filter @zcode/provider test` and typecheck, `pnpm typecheck`,
`pnpm lint`, format check, `git diff --check`, and a search that no old remote model facts, runtime modelId
hardcode or second capability DTO remain. No UI interaction code changed, so no new Desktop E2E; settings and
selector read revision 3 through the Registry projection (invariant regression only).

## 5. Outcome

Built-in Config is revision 3: 21 Providers, 131 Match Rules, 179 Provider-Model Exact Rules. Individual/Team add
GLM-5.3; normal Account API and Plan vision facts are separated. Kimi K2.7 Code, Qwen 3.8 Max/Flash and MiMo v2.5
Audio static facts added. DeepSeek/Qwen old rules no longer pass JSON Object as strict Schema; DeepSeek's official
Responses Endpoint is promoted separately. Every Built-in member has a unique Exact enabled and enabled members form
a contiguous prefix of `builtinModelIds`. Verification: Provider/Provider Node directed tests and typecheck,
Provider Runtime tests, root typecheck, root lint (pre-existing warnings only), full unit (1492 files passed, 12730
tests passed).
