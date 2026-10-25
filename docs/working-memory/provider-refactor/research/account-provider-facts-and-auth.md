# Account Provider Configuration, Access Scope, and Request Authentication

> Investigation Date: 2026-08-17
>
> Scope: M2 Account Access Source and subsequent ModelFactory boundary design
>
> Document identity: Historical status investigation. Account Config, request-period authentication, and Remote Environment authoritative boundaries have been ruled by
> [`02-provider-config-and-registry-human-in-the-loop.md`](../steps/02-provider-config-and-registry-human-in-the-loop.md)
> and have entered the current Design and M2 implementation; the main text preserves the context at the time of investigation.

This document clarifies fact ownership in the Start Plan, Personal Coding Plan, and Team Plan chains. It records the then-current status and migration boundaries and does not change Provider Family selection behavior.

## Conclusions

The pre-M2 implementation packed three data types with different lifecycles into the same Provider Registry Snapshot:

```text
Provider / Model static definitions
        +
Account and plan allowed scope
        +
JWT / Runtime API Key / one-time security verification header
        |
        v
Old ZCodeProviderRegistrySnapshot
```

The new chain splits facts by lifecycle:

```text
Official Config
├─ Account Provider's providerId, label, apiFormat, baseURL
├─ Full set and order of models declared by the Provider
└─ Model Properties, Option Specs, and reasoning mapping

Account Access
├─ Account Provider actually allowed for the current account
├─ modelId allowed for each Provider currently
└─ Non-sensitive account access identity that must be fixed when creating a Model

Request Auth
├─ Login Token / JWT
├─ Personal Coding Plan API Key
├─ Team Project Runtime API Key
├─ One-time security verification header
└─ Refresh and retry strategies after failure
```

The Registry composes only the first two types of facts. Request-period authentication does not enter the Registry, nor is it serialized to the Renderer.

## Why Account Access Still Needs an Access Identity

Personal Coding Plan and Team Plan can share the same `providerId`. If a Model stores only `providerId + modelId` and each request reads "the currently selected connection," a loop that created its Model on the Personal plan silently switches to Team after the user changes the connection. This violates the established Model lifecycle: the model identity and execution configuration held by one continuous execution remain stable. Registry-published Account Access entries therefore include a fixable access identity that locates "which account/plan connection to request credentials from" and contains no secrets.

M2 semantics:

```ts
interface AccountProviderAccessEntry {
  providerId: ProviderId;
  modelIds: readonly ModelId[];
  accessId: string;
}
```

The ModelFactory copies `accessId` when creating a Model. Each request uses this ID through the Request Auth Service to obtain the current valid credential. Token refreshes can affect the next request, but cannot swap a Personal connection for a Team connection, nor swap the Provider or Model.

## Current Family Behavior

`filterResolvedProviderFamiliesForRegistry()` selects one active Provider from each of the Z.ai and BigModel families:

```text
API Key mode
└─ API Provider

OAuth mode
├─ Team Plan selected -> Coding Plan Provider
├─ Personal Coding Plan available -> Coding Plan Provider
└─ Otherwise -> Start Plan Provider
```

This simultaneously handles product selection and old Registry deduplication; M2 does not change it. The Account Access Source first projects the same "current active Provider + model scope"; whether multiple connections can be published from the same Family is a later independent design.

## Current Status of Static Model Facts

Pre-M2 static facts came from `/client/configs` (remote Providers, models, Schemas), `presetModelDefaults.ts` (GLM fallback model set), `modelProviderServiceStorage.ts` (fallback Providers, Endpoints, models), `model-provider-types.ts` (Start Plan free models, reasoning special cases), and China LLM Catalog plus runtime code (Properties, Option Specs, Provider Options Patches).

Under the target design these sources cannot independently participate in the Registry: stable facts migrate to Official Config; model IDs returned by account interfaces serve only as Account Access filter scope. Start Plan is the clearest example — `billing/balance` returns the plan-allowed model IDs and `client/configs.builtinModels` supplements their facts. In the new design, Official Config maintains the complete model-fact set and Balance returns only the current available subset. When Balance and Official are temporarily inconsistent, the Account Source explicitly adopts last-known-good or reports configuration inconsistency, rather than creating half-complete models with only modelIds in the Registry.

## Endpoints and Product Environments

Account Provider Endpoints have production, testing, and other environment branches; e.g., Z.ai Coding Plan uses `resolveZaiBusinessBaseUrl(process.env)` and Start Plan uses a zcode-plan gateway derived from the current ZCode Endpoint. Once Official Config is the single source of truth, the Registry and Provider Factory must not rewrite these fields from `process.env`. Each product environment receives a fully resolved Official Config (production / test / dev-injected endpoints) with the same Schema, generated per environment by the publishing service; runtime Sources read one complete document. Environment selection belongs to Official Config publishing and injection, not a fourth fact source for the Registry.

## Current Request Authentication

```text
Start Plan
├─ zcode JWT from login
└─ One-time security verification header obtained before request attempt

Personal Coding Plan
├─ OAuth access token for querying account and plan
└─ Model call API Key created or copied through business interfaces

Team Plan
├─ Selected organization / project
└─ Runtime API Key created or copied for that project
```

The old implementation sometimes wrote or projected copied Keys or JWT as Provider `apiKey`; the new Account Access Source must not continue this. The Request Auth Service obtains request materials from a fixed access identity and independently handles caching, refreshing, and forced refresh after authentication failures; these strategies do not change the Registry View.

## Still to be Ruled Before Implementation

```text
Option A: Each Provider Family publishes only one current active connection
Option B: Publish multiple available connections simultaneously, and let ModelSelection include connection identity
```

Option A maintains current behavior and keeps `providerId + modelId + options` sufficient to express Selection. Option B expands selectors, Session persistence, Submission protocol, and Model identity boundaries. M2 adopts Option A; regardless of future extensions, Models must fix the `accessId` at creation time, avoiding runtime drift with global selection changes.
