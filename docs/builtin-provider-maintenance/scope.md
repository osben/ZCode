# Maintenance Scope and Principles

## How the mainstream scope is determined

The coverage goal is the mainstream vendors and mainstream coding and Agent models users actually need; it is neither a copy of some platform's full catalog nor a permanently fixed set of a few brands.

When evaluating a vendor or model, record the following basis:

1. Product relevance: whether code, reasoning, tool calling, multi-turn Agent work or necessary multimodal input suits the current execution chain.
2. Demand: user feedback, existing usage, explicit integration requests; news buzz and leaderboards give leads only and do not decide admission alone.
3. Availability: a usable API product, a legitimate model ID, obtainable credentials and clear region/plan requirements; a usable chat web page does not mean a usable API.
4. Maintenance cost: whether the protocol, tool loop, streaming response and authentication can be expressed reliably by existing capabilities; whether there are ongoing maintainers and validation resources.
5. Lifecycle: GA, preview, alias, retirement date, replacement model and interface changes. Models must not be deleted merely by newer or older version number.

## Authorization boundary for additions and existing changes

Confirmed 2026-10-14: **for additions that fit the established scope, the existing protocols and the validation requirements, maintainers may research, add specs/tests, implement and submit an MR directly, without asking product approval one by one; to modify or delete existing configuration, first explain the plan to a person and discuss and confirm, then execute.** This authorization does not mean one may publish, make paid calls or change user configuration.

| Action | Handling |
| --- | --- |
| Add a template, a new model member, and rules that act only on the newly added identities | Proceed when the material and protocol evidence is sufficient; with no real-key validation default to disabled with an explicit pending-validation mark, and do not stop all preparation that can be completed |
| Adjust existing model capabilities, thinking values/Map, default enablement, ordering; change an existing URL, Access or template identity | First list the current state, the proposed values, the reason, the affected entries/users and the compatibility plan, then implement after discussion and confirmation |
| Delete, downgrade, disable, or replace a model or template | Same as above; official retirement notices and missing catalog entries are discussion evidence and not automatic authorization |
| Add a broad rule that would hit existing models or other entries | Treat as an existing change; "just appending JSON" must not bypass discussion; first compare the resolved results of the old members |
| Bump the revision for the new item, derive the test configuration, update the inventory and maintenance docs | Necessary accompanying work of the addition, may be done directly; no other configuration change may be slipped in |

Discussion is per concrete before/after difference; when the authorization range is already clear do not ask repeatedly. Research and gap records can continue; unconfirmed existing changes are listed separately as to-discuss and do not block independent additions. The state of lacking a key and whether an addition has been approved are recorded separately.

Confirmed again 2026-10-15: **anything needing extra integration adaptation is not integrated for now; vendors, product entries and models the existing execution chain can support directly may proceed, with no per-item integration approval.** A batch only expresses implementation order; "later" or "on demand" must not be read as not yet authorized. The unit of judgment remains the concrete product entry, model and protocol, not allowing or excluding by brand.

In the short term only the three existing API types `anthropic-messages`, `openai-chat-completions` and `openai-responses` are used. Adding templates, members, capability fields and parameter mappings in the existing CEL Option Map is configuration maintenance; adding a protocol or authentication method, dynamic credentials/Headers, request encoding, response streaming or history conversion, and adding/upgrading an SDK for compatibility are extra adaptation and are postponed this round. Routine tests, docs, Logo and name maintenance are not protocol adaptation.

The Google native Gemini API is postponed; an official Chat-compatible entry or an aggregating entry may also proceed under the addition principle if it can be shown that the existing execution chain supports it without change, and it must not be described as native protocol support. Mistral paths needing response/history block conversion, cloud entries needing authentication refresh, and paths needing new session-Header wiring are likewise postponed; record the gap and do not develop adaptation in passing during this expansion. An official compatible endpoint does not mean the tool loop has passed; the material, key validation and default-enablement requirements are unchanged, and existing configuration stays as is.

The addition principle updates this directory in the same round the conclusion is formed: the scope is written into this page, the flow is synced to the maintenance workflow, and specific candidates/exceptions update the expansion plan; it must not remain only in chat or MR comments.

## Three lists

| List | Meaning | How it enters configuration |
| --- | --- | --- |
| Maintained | Templates and model members in the current JSON | See [Current state](./current-state.md); does not mean everything was measured this round |
| Under observation | New models of mainstream vendors, gaps in existing entries, potential new vendors | Collect evidence, validate, and submit a separate configuration MR |
| Awaiting capability design | New protocols, cloud credentials, deployment identity and others beyond the existing contract | Postponed this round with the gap recorded; confirmed separately later, not bypassed with pseudo-compatible configuration |

Existing coverage includes Z.AI, BigModel, Kimi, MiniMax, DeepSeek, Qwen, MiMo, OpenAI, Anthropic, xAI, and OpenRouter and OpenCode Go/Zen. Concrete entries and models follow the current state and the JSON.

The observation scope includes Google Gemini, Mistral, Tencent TokenHub, Volcano Ark, StepFun, SiliconFlow, and cloud entries such as Azure and AWS Bedrock; this is not a list in which every candidate already meets the integration conditions; items fitting the addition principle above need no per-item re-approval. Current evidence, concrete models, priority and unvalidated conditions are in the [expansion plan](./expansion-plan.md). Google native protocol versus Vertex, cloud platform credentials/deployment names are evaluated separately; compatible API, native protocol and cloud identity authentication must not be merged into one conclusion.

A cloud-entry investigation must first clarify the actual product path and then decide whether an ordinary template can express it. The following official contracts were checked on 2026-10-14, with real credentials and the execution chain not yet validated; evidence links and candidates are in the expansion plan:

- Azure: the v1 API Key path can use a compatible client and needs no date-style API version; the relation among resource URL, Deployment and model capability must still be validated. Paths needing new Entra identity or automatic refresh adaptation are postponed this round.
- Volcano Ark: confirm separately the key, endpoint and Model / Endpoint ID of the ordinary API, Coding Plan and Agent Plan; a plan model must not be used directly as an ordinary API identity.
- AWS Bedrock: first distinguish the API Key + Responses-compatible path from the IAM / signing path. The former does not automatically require a new protocol; Region, runtime / mantle, Profile ID and permissions still need validation. Capabilities such as credential refresh that existing Access lacks are postponed this round.
- Gemini/Vertex: validate native and compatible protocols separately; model capability, tool encoding, authentication and product entry cannot vouch for one another. That the native protocol is not integrated does not mean stopping to watch its model changes.

## Maintenance level and default enablement

- **Key maintenance**: currently promoted, Agent-suited models, usually default enabled; weigh capability, speed, cost and stability together and do not mechanically pick only the largest model.
- **General maintenance**: other models the official entry still accepts and that have value, usually default disabled, selectable by users.
- **Observation / to validate**: keep a record first; adding as default enabled requires validation evidence for the corresponding entry, and a model must not be added automatically because it is free, popular or announced in the news.
- **Exit maintenance**: explicitly retired, no longer accepted by the actual entry, or moved out of scope by product confirmation; record the reason and the replacement.

These are maintenance principles. Existing default enablement has historical differences (see the current state); changing an existing value is a configuration behavior change and must be stated explicitly in the corresponding MR.

Default enablement is written in `templateModelRules` and not inferred from UI names. Template members, default enablement and capability rules are reviewed separately. Moving from key to general maintenance is not deletion; removing a template is not deleting user-defined models or historical selections.

## Product entry and protocol

- When the endpoint or credentials of the ordinary API, Coding Plan and Token Plan differ, split templates by product entry. Split by region only when actual configuration/product requirements differ and existing templates cannot express it clearly.
- Following the established principle: an official template prefers the already-validated Anthropic Messages; when not supported, use another protocol the entry actually supports and that is sufficiently validated. This does not require migrating existing Responses/Chat templates.
- A template has exactly one `api.type`. When models of one site need different protocols, split templates the existing way; do not put incompatible models in one template and guess the protocol at runtime.
- `templateId` is stable and the instance `providerId` is independent. Modifying a template should not rename user instances, overwrite user addresses or rewrite saved selections.
- Capabilities follow the official model and protocol; do not lower the capabilities of all models of the same type because of a lagging third-party proxy. Known site differences go in Site rules; a user's own proxy limits are expressed by an exact personal override.

## Aggregating vendors

The target scope of OpenRouter is the intersection of "maintained upstream models" and "models this entry actually provides and are usable". Do not copy the whole dynamic catalog and do not cover only a few brands; each included upstream brand should have suitable key models, and the rest are chosen by maintenance level.

OpenCode Go and Zen are different product catalogs; verify model permissions, endpoints and protocols for each. The existing three-protocol templates continue to be maintained separately; an ID or entitlement returned by Zen must not be used as evidence for Go. When integrating other aggregating vendors, redefine the scope and do not copy one vendor's catalog structure.

Aggregated model IDs are stored as is, including vendor prefix, case and suffixes with real routing meaning. Uniformly stripping prefixes at runtime is forbidden. Batch, image generation, Embedding, TTS, dedicated completion and the like must not be added to the current chat/Agent templates merely because they appear in a Models API; the corresponding product execution capability is needed.

## Removal and compatibility

First check official retirement / alias routing changes, then distinguish four actions: remove a member, turn off default enablement, delete a capability rule, and migrate an identity. A general rule may still serve other templates or user-defined models; an exact rule detached from static members may also act on a personally added model of the same ID, so it must not be deleted by set difference alone.

When a saved model or thinking level becomes invalid, handle it with the existing selection validation, and do not silently replace it with a new model or the highest level. Any automatic migration needs an independent, explicit product decision and regression evidence.
