# Start Plan Preview Entitlements

`client/configs.configs.startPlanPreview.entitlements` returns one entitlement per model; the Trial plan card must show that detail rather than collapsing it into one quota summary and a slash-joined model string.

Rules:

- The Start Plan entry stays visible for disconnected users. The Trial plan card renders only when `client/configs.configs.startPlanPreview` exists and has displayable entitlements; otherwise it is not rendered and no local hardcoded quota copy is used.
- The Trial plan card title is the remote `startPlanPreview.name`.
- The purchased Start Plan status card title stays `Start Plan` when the active entitlement name is a Start entitlement (for example `Start`, `ZCode V3 Start Plan`). If a paid Coding Plan entitlement is rendered through the Start Plan provider branch, the title uses the entitlement/product name instead of the hardcoded `Start Plan`.
- Every displayable `model_usage` entitlement with positive `grantUnits` and non-empty `showName` contributes its model name to the supported model list.
- The hero quota is the sum of displayed entitlement `grantUnits` sharing unit and period, shown once as the Trial plan total. English hero uses long compact wording (`5 Million tokens per day`); the Chinese hero stays localized compact (`500万 tokens/日`).
- The detail sentence keeps compact token units and groups models by equal `grantUnits`: English `Daily quota · GLM-5.2 / GLM-5-Turbo 10M each` when quotas are equal, `Daily quota · GLM-5.2 30M · GLM-5-Turbo 10M` when one differs; Chinese uses `万` / `亿`.

Compatibility: UI-only — no provider, stream, runtime, or remote-control changes. Layout wraps naturally on desktop and mobile web with semantic theme tokens from `DESIGN.md`.
