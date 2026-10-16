# 22 Additional Built-in Providers and Cloud Platform Access

> Status: Draft
>
> Date: 2026-08-26
>
> Source: New Provider scope confirmed during ZCode Built-in Config content organization; split out from Todo 21 to avoid config
> responsibility refactoring and new Provider/Access integration blocking each other
>
> Related tasks: [`21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)
>
> Related design: [`Provider and Model Configuration System Overview`](../design/registry/provider-and-model-configuration-overview.md),
> [`configuration.md`](../design/registry/configuration.md)

## 0. Task Positioning

This Todo independently handles normal aggregation gateways and cloud platform Providers not yet in the current `config/provider/zcode-builtin.json`. Todo 21 continues
to consolidate Provider/Model config responsibilities, enablement, ordering, Settings, and Access ownership; does not expand critical path by waiting for new Provider Adapter or Access Type.

Built-in only means the template is maintained by ZCode internally, not that it uses a ZCode account. New normal Providers have their default availability determined by Template Model's `enabled`:

```text
Template Model Rule
└─ enabled = false (default)
```

Users select from "Add Supplier" to create Personal Provider Instances, then corresponding Personal Model Rules save model enable/disable and access material; only entering Registry when config is complete.

## 1. Current Candidate Scope

### 1.1 Prioritize Verifying Existing API Access Can Express Fully

- OpenRouter;
- OpenCode Zen;
- Microsoft Azure AI Foundry / Azure OpenAI;
- Volcano Engine Ark.

These Providers are added as normal Built-in Provider templates only when existing `api.type + api.baseURL + access.type="api"` can accurately express real Endpoint, Header, request parameters, and
model ID semantics. Cannot skip final request body and response stream validation just because the service claims OpenAI-compatible.

### 1.2 Explicitly Requiring New Access Design

- AWS Bedrock.

Bedrock's Region, credential source, request signing, Endpoint generation, and model identity cannot be disguised as ordinary API Key + hand-written URL. Before formal implementation,
Bedrock Access, Adapter assembly, Settings form, credential lifecycle, and Local/Remote Environment boundaries must be designed first.

### 1.3 Currently Excluded

- Google Gemini native Provider;
- Google Vertex AI.

Google-related integration is not currently supported; no Adapter or Access Type is created by the way in this Todo. Future re-project will be based on then-official interface design.

## 2. Common Principles

1. Provider templates enter the same ZCode Built-in Release, do not restore Catalog, Preset, or remote second fact source;
2. Provider identity, API, Endpoint template, and Access belong to Built-in Provider Config;
3. Model Properties, Option Specs, Reasoning Mapping, and necessary request encoding facts belong to Built-in Model Config Rules;
4. Normal Providers do not write hardcode in Adapter/Runtime by Provider ID or Model ID;
5. Each new Provider must have final HTTP request/response contract evidence, cannot just prove SDK factory can create;
6. Settings uses Todo 21's "Add Supplier" entry, explicit `builtin`, enablement, and ordering contracts;
7. Local workspace uses Local Host config, remote workspace uses Remote Host config and credentials, does not project local facts from Renderer;
8. Do not publish seemingly configurable but actually unexecutable Built-in templates for unimplemented Access/Adapter.

## 3. Pre-Implementation To-Be-Designed

### 3.1 OpenRouter and OpenCode Zen (Migrated)

> This section has been migrated to [Todo 79: OpenRouter / OpenCode Provider Integration Boundary and Existing Foundation](./todo-79-openrouter-opencode-provider-integration-boundary.md). Todo 22 still retains planning for Azure, Volcano Ark, and AWS Bedrock, and should not be marked as completed as a whole.

- Confirmed public API Schema used;
- Confirmed whether model IDs contain `/` and how they are handled in structured `ModelSelection`;
- Confirmed actual request/response for reasoning, tool call, structured output, web search, and usage;
- Confirmed Endpoint, API Key management address, and recommended model members;
- Confirmed whether current Adapter needs any evidence-based narrow compatibility facts.

See Todo 79. Original OpenRouter/OpenCode discussions are retained as migration index, not maintained here redundantly.

### 3.2 Azure

- Confirmed resource Endpoint, Deployment, and Model ID relationship;
- Confirmed whether API version belongs to static API config, Endpoint query, or Adapter option;
- Confirmed API Key Header and response protocol;
- If existing API Access cannot express fully, upgrade Access/API design first, do not write half-finished products in Built-in JSON.

### 3.3 Volcano Ark

- Confirmed Endpoint/Deployment ID, API Key, and model identity;
- Confirmed compatibility of current OpenAI-compatible Adapter's requests and streaming responses;
- Confirmed recommended models and their complete Model Config Facts.

### 3.4 AWS Bedrock

- Domain structure of new Access Type;
- Region, static credentials, credential references, and request-period refresh boundaries;
- SigV4 or current formal signature protocol Transport location;
- Security boundaries of Endpoint auto-generation and custom Endpoints;
- Mapping of Bedrock Model ID to Provider's original Model ID;
- Credential entry and execution ownership for Desktop, CLI, Web/Remote Host;
- Connectivity, error normalization, and log sanitization.

## 4. Acceptance Principles

Each Provider must at minimum prove:

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

And cover:

- Template Model default `enabled=false`, model enable/disable is saved by corresponding Personal Model Rule after creating Personal Provider Instance;
- When access material is missing, retain Settings editable state but do not enter Registry;
- Model Rules can parse complete Properties, Options, and Reasoning Mapping;
- Tool Call, Structured Output, Reasoning, and Usage have at least representative real request evidence;
- Deleting provider only deletes Personal config, Built-in template falls back;
- Provider/Model order follows Todo 21;
- Local/Remote Environment does not mix config or credentials;
- Typecheck, Lint, Config integrity, and related Adapter tests pass.

## 5. Non-Goals

- Do not prematurely publish the above half-finished Providers in Todo 21;
- Does not support Google Gemini or Vertex AI;
- Does not forcibly model Bedrock as ordinary API Key Provider;
- Does not promise all aggregation gateways' arbitrary models have the same capabilities;
- Does not restore models.dev, Catalog, runtime inference by model name, or Provider family hardcode;
- Does not uniformly refactor all `/client/configs` consumers.

## 6. Draft Status Exit Conditions

This Todo can only be changed to "Ready to Execute" after the following items are completed:

1. Confirm existing Adapter/Access expressibility for OpenRouter, OpenCode Zen, Azure, Volcano Ark respectively;
2. Complete AWS Bedrock Access special design;
3. Confirm first-batch Built-in models and authoritative fact source for each Provider;
4. Confirm implementation slices and real request validation conditions;
5. Write final Provider/Access contracts to Design Tree.
