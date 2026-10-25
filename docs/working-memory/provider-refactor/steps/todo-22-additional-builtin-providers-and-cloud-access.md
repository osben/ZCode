# 22 Additional Built-in Providers and Cloud Platform Access

> Status: Draft
>
> Date: 2026-08-26
>
> Source: New Provider scope confirmed during ZCode Built-in Config content organization; split out from Todo 21 so
> config-responsibility refactoring and new Provider/Access integration do not block each other.
>
> Related tasks: [`21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)
>
> Related design: [`Provider and Model Configuration System Overview`](../design/registry/provider-and-model-configuration-overview.md),
> [`configuration.md`](../design/registry/configuration.md)

## 0. Task Positioning

Independently handles normal aggregation gateways and cloud platform Providers not yet in
`config/provider/zcode-builtin.json`. Todo 21 keeps consolidating config responsibilities, enablement, ordering,
Settings and Access ownership and does not wait for new Provider Adapters or Access Types.

Built-in only means the template is maintained by ZCode, not that it uses a ZCode account. Default availability of
new normal Providers is decided by the Template Model's `enabled`:

```text
Template Model Rule
└─ enabled = false (default)
```

Users pick from "Add Supplier" to create a Personal Provider Instance; Personal Model Rules then save model
enable/disable and access material; the Provider enters Registry only when config is complete.

## 1. Candidate Scope

### 1.1 Verify first that existing API Access can express them fully

- OpenRouter;
- OpenCode Zen;
- Microsoft Azure AI Foundry / Azure OpenAI;
- Volcano Engine Ark.

Each is added as a normal Built-in Provider template only when existing `api.type + api.baseURL +
access.type="api"` accurately expresses the real Endpoint, Header, request parameters and model ID semantics. Final
request body and response stream validation cannot be skipped because a service claims OpenAI-compatible.

### 1.2 Requires new Access design

- AWS Bedrock. Region, credential source, request signing, Endpoint generation and model identity cannot be
  disguised as an ordinary API key + hand-written URL. Before implementation, design Bedrock Access, Adapter
  assembly, Settings form, credential lifecycle and Local/Remote Environment boundaries.

### 1.3 Excluded

- Google Gemini native Provider and Google Vertex AI. No Adapter or Access Type is created for them here; revisit
  later against the then-official interface.

## 2. Common Principles

1. Provider templates enter the same ZCode Built-in Release; Catalog, Preset or remote second fact sources are not
   restored.
2. Provider identity, API, Endpoint template and Access belong to Built-in Provider Config.
3. Model Properties, Option Specs, Reasoning Mapping and necessary request encoding facts belong to Built-in Model
   Config Rules.
4. Normal Providers are not hardcoded in Adapter/Runtime by Provider ID or Model ID.
5. Each new Provider needs final HTTP request/response contract evidence, not just proof that an SDK factory can
   create it.
6. Settings uses Todo 21's "Add Supplier" entry, explicit `builtin`, enablement and ordering contracts.
7. Local workspace uses Local Host config; remote workspace uses Remote Host config and credentials; Renderer does
   not project local facts.
8. No seemingly configurable but unexecutable Built-in templates are published for unimplemented Access/Adapter.

## 3. Open Items Before Implementation

### 3.1 OpenRouter and OpenCode Zen (migrated)

Migrated to [Todo 79: OpenRouter / OpenCode Provider Integration Boundary and Existing Foundation](./todo-79-openrouter-opencode-provider-integration-boundary.md).
Todo 22 keeps the planning for Azure, Volcano Ark and AWS Bedrock and must not be marked completed as a whole. The
questions carried over to Todo 79: public API Schema, whether model IDs contain `/` and how they appear in structured
`ModelSelection`, real request/response for reasoning/tool call/structured output/web search/usage, Endpoint, API
Key management address and recommended members, and any evidence-based narrow compatibility facts.

### 3.2 Azure

- Resource Endpoint, Deployment and Model ID relationship.
- Whether API version belongs to static API config, Endpoint query or Adapter option.
- API Key Header and response protocol.
- If existing API Access cannot express it, upgrade Access/API design first; no half-finished products in Built-in
  JSON.

### 3.3 Volcano Ark

- Endpoint/Deployment ID, API Key and model identity.
- Compatibility of the current OpenAI-compatible Adapter's requests and streaming responses.
- Recommended models and their complete Model Config facts.

### 3.4 AWS Bedrock

- Domain structure of the new Access Type.
- Region, static credentials, credential references and request-period refresh boundaries.
- Transport location of SigV4 or the current formal signing protocol.
- Security boundaries of Endpoint auto-generation and custom Endpoints.
- Mapping of Bedrock Model ID to the Provider's original Model ID.
- Credential entry and execution ownership for Desktop, CLI, Web/Remote Host.
- Connectivity, error normalization and log sanitization.

## 4. Acceptance Principles

```text
Built-in Provider Template
        +
Personal Access/Endpoint Overlay
        +
Built-in Model Config Rules
        |
        v
Complete Registry Provider/Model
        |
        v
Real generate + stream requests
```

Each Provider must also prove:

- Template Model default `enabled=false`; model enable/disable is saved by the Personal Model Rule after the
  Personal Provider Instance exists.
- Missing access material keeps Settings editable but does not enter Registry.
- Model Rules parse complete Properties, Options and Reasoning Mapping.
- Tool Call, Structured Output, Reasoning and Usage have at least representative real request evidence.
- Deleting the provider deletes only Personal config; the Built-in template falls back.
- Provider/Model order follows Todo 21.
- Local/Remote Environment does not mix config or credentials.
- Typecheck, Lint, Config integrity and related Adapter tests pass.

## 5. Non-Goals

- Do not publish the above half-finished Providers in Todo 21.
- No Google Gemini or Vertex AI support.
- Do not model Bedrock as an ordinary API key Provider.
- No promise that arbitrary models on aggregation gateways share capabilities.
- Do not restore models.dev, Catalog, runtime inference by model name or Provider family hardcode.
- Do not unify all `/client/configs` consumers.

## 6. Exit Conditions from Draft

Change to "Ready to Execute" only after:

1. confirming existing Adapter/Access expressibility for OpenRouter, OpenCode Zen, Azure and Volcano Ark;
2. completing the AWS Bedrock Access design;
3. confirming first-batch Built-in models and the authoritative fact source per Provider;
4. confirming implementation slices and real-request validation conditions;
5. writing final Provider/Access contracts to the Design Tree.
