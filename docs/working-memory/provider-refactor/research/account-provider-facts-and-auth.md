# Account Provider Configuration, Access Scope, and Request Authentication

> Investigation Date: 2026-08-17
>
> Scope: M2 Account Access Source and subsequent ModelFactory boundary design
>
> Document identity: Historical status investigation. Account Config, request-period authentication, and Remote Environment authoritative boundaries have been ruled by
> [`../steps/02-provider-config-and-registry-human-in-the-loop.md`](../steps/02-provider-config-and-registry/zcode-builtin-provider-config.md)
> and have entered the current Design and M2 implementation; the main text preserves the context at the time of investigation.

This document clarifies fact ownership in the current Start Plan, Personal Coding Plan, and Team Plan chains. It records the current status and migration boundaries, and does not change the current Provider Family selection behavior.

## Conclusions

The existing implementation packs three data types with different lifecycles into the same Provider Registry Snapshot:

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

The new chain needs to be split by fact lifecycle:

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

The current Personal Coding Plan and Team Plan can share the same `providerId`. If a Model only stores `providerId + modelId`, and each request reads "the currently selected connection," the following timing occurs:

```text
Loop A creates Model
└─ Selected Personal Coding Plan at the time

User switches to Team Plan
└─ Current connection in Account Service changes

Loop A's next request
└─ If credentials are fetched only by providerId, it silently switches to Team Plan
```

This violates the established Model lifecycle: the model identity and execution configuration held by the same continuous execution remain stable. Therefore, entries published by Account Access to the Registry need to include a fixable access identity. It only locates "which account/plan connection to request credentials from," and does not contain secrets.

M2 uses the following semantics:

```ts
interface AccountProviderAccessEntry {
  providerId: ProviderId;
  modelIds: readonly ModelId[];
  accessId: string;
}
```

The ModelFactory copies `accessId` when creating a Model. Each model request uses this ID through the Request Auth Service to obtain the current valid credential. Token refreshes can affect the next request, but cannot swap a Personal connection for a Team connection, nor swap the Provider or Model.

## Current Family Behavior

`filterResolvedProviderFamiliesForRegistry()` currently selects one active Provider from each of the Z.ai and BigModel families:

```text
API Key mode
└─ API Provider

OAuth mode
├─ Team Plan selected -> Coding Plan Provider
├─ Personal Coding Plan available -> Coding Plan Provider
└─ Otherwise -> Start Plan Provider
```

This behavior simultaneously handles product selection and old Registry deduplication. M2 does not currently change this behavior. The Account Access Source should first project the same "current active Provider + model scope," and then subsequent independent designs determine whether multiple connections can be published from the same Family.

## Current Status of Static Model Facts

Current static facts come from multiple locations:

- `/client/configs` provides remote Providers, models, and Schemas.
- `presetModelDefaults.ts` provides the fallback model set for GLM Provider.
- `modelProviderServiceStorage.ts` provides fallback Providers, Endpoints, and models.
- `model-provider-types.ts` stores Start Plan free models and reasoning special cases.
- China LLM Catalog and runtime code continue to supplement Properties, Option Specs, and Provider Options Patch.

These sources cannot continue to participate independently in the Registry under the target design. Stable facts need to be migrated to Official Config; available model IDs returned by account interfaces serve only as Account Access filter scopes.

The Start Plan is currently the clearest example: `billing/balance` returns the plan-allowed model IDs, and `client/configs.builtinModels` supplements model facts for these IDs. In the new design, Official Config should maintain the complete set of model facts, and Balance returns only the current available subset. When Balance and Official are temporarily inconsistent, the Account Source should explicitly adopt last-known-good or report configuration inconsistency, rather than creating half-complete models with only modelIds in the Registry.

## Endpoints and Product Environments

Account Provider Endpoints currently have production, testing, and other environment branches. For example, Z.ai Coding Plan uses `resolveZaiBusinessBaseUrl(process.env)`, and Start Plan uses a zcode-plan gateway derived from the current ZCode Endpoint.

Once Official Config becomes the single source of truth, the Registry and Provider Factory cannot rewrite these fields again using `process.env`. Each product environment should receive a fully resolved Official Config:

```text
Production Official Config
└─ production endpoints

Test Official Config
└─ test endpoints

Dev / injected Official Config
└─ local or developer endpoints
```

They use the same Schema and can be generated by the publishing service per environment; runtime Sources still read only one complete document. This way, environment selection belongs to Official Config publishing and injection, and does not become a fourth fact source for the Registry.

## Current Request Authentication

The request credentials for the three Plan types differ:

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

The old implementation sometimes wrote or projected copied Keys or JWT as Provider `apiKey`. The new Account Access Source must not continue this pattern. The Request Auth Service must obtain request materials based on a fixed access identity, and handle caching, refreshing, and forced refreshes after authentication failures independently; these strategies do not change the Registry View.

## Still to be Ruled Before Implementation

The Account Access Source implementation needs to first determine one product semantic:

```text
Option A: Each Provider Family publishes only one current active connection
Option B: Publish multiple available connections simultaneously, and let ModelSelection include connection identity
```

Option A maintains current behavior and keeps `providerId + modelId + options` sufficient to express Selection. Option B expands selectors, Session persistence, Submission protocol, and Model identity boundaries. M2 adopts Option A; regardless of future extensions, Models must fix the `accessId` at creation time, avoiding runtime drift with global selection changes.
