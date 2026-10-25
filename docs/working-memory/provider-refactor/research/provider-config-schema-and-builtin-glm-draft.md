# Provider Config Schema and Builtin GLM Draft

> Status: Config structure has entered Design; this document preserves GLM API facts and pre-release verification items
>
> Record Date: 2026-08-18
>
> Scope: Provider Config, Model Config Rules, Account Access, GLM-5.2, GLM-5.3, and GLM-5-Turbo

This draft saves the structures converged in that round of discussion and the parts still needing code and online behavior verification. Implementation and reviews follow the formally accepted conclusions in Design.

## 1. Currently Converged Overall Shape

The Provider Registry's static facts are three layers of same-form Provider Config Overlays:

```text
Official Provider Config
        +
Personal Provider Config
        +
Account Access Overlay
        |
        v
Effective Provider Config
        |
        +---- Model Config Rules
        |
        v
Provider Registry
        |
        | ModelSelection
        v
Model
```

- Official saves product-managed Providers, model members, model public properties, and protocol configurations.
- Personal saves user-created Providers and explicit overrides to Official Providers.
- Account Access publishes currently available Account Providers, model subsets, and access identities based on the current account, plan, and connection state.

Official and Personal are persistent; Account Access is an in-memory runtime Overlay. Request authentication materials (Login Tokens, Runtime API Keys, one-time security verification Headers) enter none of the three layers, nor the Registry.

Provider configs and model configs are complementary:

```text
Provider Config
└─ How to connect, how to obtain access eligibility, which modelIds to include

Model Config Rules
└─ Properties, Option Specs, and protocol behavior for modelId
```

## 2. Provider Config Schema Draft

A Provider's "access eligibility" and "request protocol" are two orthogonal dimensions, aggregating in the same ProviderConfig but each using Schemas with discriminant fields.

```ts
type ProviderConfigMap = ConfigOverlayMap<ProviderId, ProviderConfig>;

class ProviderConfig extends ConfigOverlay {
  label?: string | null;
  logoUrl?: string | null;
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  models?: readonly ModelId[] | null;
  enabled?: boolean | null;
}
```

The outer ProviderConfigMap's key is providerId, so values do not redundantly save it. All fields stay optional so the same type expresses either a sparse overlay layer or the post-override result. Missing fields inherit from previous layers; null means this layer explicitly clears the field.

### 2.1 Access

Access describes "where this call's eligibility comes from."

```ts
type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

class ApiKeyAccessConfig extends ConfigOverlay {
  readonly type = "api-key";
  apiKey?: string | null;
  apiKeyManagementUrl?: string | null;
}

class ZhipuAccountAccessConfig extends ConfigOverlay {
  readonly type = "zhipu-account";
  accessId?: string | null;
}
```

The formal scope covers api-key and zhipu-account; future vendor OAuth and other access methods extend new branches when concrete needs arise. `apiKeyManagementUrl` is product information for the settings page to jump to the vendor's Key management page, explicitly provided by Provider Config, not inferred from baseURL.

Zhipu Account's accessId identifies a specific account connection, not just a Plan type. It stays stable when the same account refreshes Tokens, Runtime Keys, or Headers; it must change when switching accounts. It is fixed after Model creation: the request auth service can refresh credentials for that connection but never silently switches a running Model to another account or personal/team connection.

### 2.2 API

API describes "where requests are sent and which public protocol they follow."

```ts
type ProviderApiType = "anthropic-messages" | "openai-responses" | "openai-chat-completions";

class ProviderApiConfig extends ConfigOverlay {
  type?: ProviderApiType | null;
  baseURL?: string | null;
  headers?: Record<string, string> | null;
}
```

External Config uses `api.type`; Adapter types are implementation details chosen by the Model construction chain, not entering user configs. Only Provider-level static Headers are retained; Model-level Headers and arbitrary model.options do not enter the config contract. OpenAI-compatible streaming `include_usage` is fixed by the Adapter and not exposed as a config item.

### 2.3 Completeness

Each overlay layer can be sparse. After covering, the Registry accepts only Providers forming complete connections:

```text
All Providers
├─ access.type
├─ api.type
├─ api.baseURL
└─ models

api-key access
└─ apiKey

zhipu-account access
└─ accessId
```

Completeness is checked by Config Classes recursively. The Settings Facade uses the same check results to display fields needing completion; the Registry filters incomplete configs without a separate judgment.

## 3. Model Config Rules

Model configs are an ordered rule set; each rule contains match conditions and a sparse ModelConfig, later hits continuing to override earlier results.

```ts
interface ModelConfigRule {
  providerMatch?: string;
  modelMatch: string;
  apiMatch?: string;
  config: ModelConfig;
}

class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  apiAdapter?: ModelApiAdapterConfig | null;
}
```

providerMatch, modelMatch, and apiMatch share pattern-matching semantics. A model's general fields and protocol fields are contributed by different rules:

```text
modelMatch = GLM-5.3
└─ Properties + Option Specs

modelMatch = GLM-5.3, apiMatch = anthropic-messages
└─ Anthropic reasoning mapping

modelMatch = GLM-5.3, apiMatch = openai-chat-completions
└─ OpenAI Chat reasoning mapping + preserved thinking replay
```

### 3.1 Properties

```ts
class ModelPropertiesConfig extends ConfigOverlay {
  contextWindow?: number | null;
  supportsImages?: boolean | null;
  supportsPdf?: boolean | null;
  supportsVideo?: boolean | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
```

supportsNativeWebSearch can be affected by Provider Endpoint capabilities: generic model rules provide conservative values, and Builtin Provider exact rules contribute the final values. supportsMidConversationSystem is `true` for the current three GLM models.

### 3.2 Option Specs and Options

Option Specs declare user-selectable options and defaults; Options save the selections bound to a Model instance.

```ts
class ModelOptionSpecsConfig extends ConfigOverlay {
  reasoningLevel?: EnumOptionSpec | null;
  maxOutputTokens?: LimitOptionSpec | null;
}

interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
```

reasoningLevel is a user option. Provider dialect fields, preserveThinking, and reasoningContentField do not belong to ModelOptions.

### 3.3 API Adapter Config

API Adapter Config saves the fixed adaptation behavior of a model under a specific public API.

```ts
class ModelApiAdapterConfig extends ConfigOverlay {
  reasoningMapping?: ReasoningMapping | null;
  preserveThinking?: boolean | null;
  reasoningContentField?: string | null;
}

type ReasoningMapping = Record<string, ReasoningParameters>;
type ReasoningParameters = Record<string, unknown>;
```

reasoningMapping maps common reasoningLevel to protocol-required parameters. preserveThinking and reasoningContentField appear only in protocols with that semantics.

```text
Model.options.reasoningLevel
        |
        v
ModelApiAdapterConfig.reasoningMapping
        |
        v
Selected request parameters for this call
        |
        v
Adapter generates final request
```

OpenAI Chat compatible dialects are the most complex, so reasoningMapping and reasoning replay primarily function there; Anthropic Messages and OpenAI Responses should follow their public protocols' fixed semantics.

## 4. Provider Type Examples

The JSON below expresses target structures only; field content is from discussions and existing code, not a directly publishable final Official Config.

### 4.1 Ordinary API Key Provider

Official can provide a not-yet-connected vendor entry point with Personal filling the API Key; users can also create Providers entirely in Personal.

```json
{
  "builtin:zai": {
    "label": "Z.AI",
    "access": {
      "type": "api-key",
      "apiKeyManagementUrl": "https://z.ai/manage-apikey/apikey-list"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://api.z.ai/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
```

Personal Overlay:

```json
{
  "builtin:zai": {
    "access": {
      "type": "api-key",
      "apiKey": "<user-api-key>"
    }
  }
}
```

BigModel API Key Providers use the same structure; the current Anthropic Endpoint is https://open.bigmodel.cn/api/anthropic.

### 4.2 Start Plan

```json
{
  "builtin:zai-start-plan": {
    "label": "Z.AI Start Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
```

Account Access generates same-form Overlays from login and plan results:

```json
{
  "builtin:zai-start-plan": {
    "access": {
      "type": "zhipu-account",
      "accessId": "zhipu-account:<account-id>:start-plan:builtin:zai-start-plan"
    },
    "models": ["GLM-5.2", "GLM-5-Turbo"]
  }
}
```

The models here are the current account's permitted subset. ZCode JWTs and one-time security verification Headers are obtained by the request auth service. BigModel Start Plan uses providerId `builtin:bigmodel-start-plan`; it currently shares zcode-plan request semantics with Z.AI Start Plan — final Endpoints and the full model set must align with remote Official Configs.

### 4.3 Personal Coding Plan

Coding Plans continue to use zhipu-account access:

```json
{
  "builtin:zai-coding-plan": {
    "label": "Z.AI Coding Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://api.z.ai/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  },
  "builtin:bigmodel-coding-plan": {
    "label": "BigModel Coding Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://open.bigmodel.cn/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
```

Account Access determines which Coding Plan Providers are published in the current Family and fills in accessIds and model subsets; the request auth service then obtains the current valid Runtime API Key via accessId.

### 4.4 Team Plan

Team Plans can reuse Coding Plan providerIds; Account Access uses different accessIds to fix organization, project, and connection identities:

```text
personal coding plan
└─ zhipu-account:<account-id>:coding-plan:builtin:zai-coding-plan

team plan
└─ zhipu-account:<account-id>:team-plan:builtin:zai-coding-plan:<product>:<org>:<project>
```

Provider Configs and Model Configs do not copy Team secrets; the request auth service obtains the Project Runtime Key via accessId. If products later publish Personal and Team connections simultaneously, whether ModelSelection carries connection identity becomes independent design; M2 keeps each Provider Family publishing only the current active connection.

### 4.5 Temporary Providers

Idle-task and other execution-scoped scenarios can attach a temporary Provider Config in Submissions, writing to neither Official, Personal, nor persistent Registries:

```text
Submission
├─ ModelSelection
└─ Additional Provider Config
        |
        v
This execution's temporary resolution scope
        |
        v
Model
```

Temporary Providers use the same ProviderConfig, Model Config, and Model construction chain. After task completion the temporary resolution scope naturally releases, without modifying or restoring Session's persistent model selections.

## 5. GLM Model Common Configurations

Provisional GLM common facts:

| Model       |   Context | Max Output | Image/PDF/Video       | Tool Call | Structured Output | MCS  |
| ----------- | --------: | ---------: | --------------------- | --------- | ----------------- | ---- |
| GLM-5.3     | 1,000,000 |    128,000 | false / false / false | true      | true              | true |
| GLM-5.2     | 1,000,000 |    131,072 | false / false / false | true      | true              | true |
| GLM-5-Turbo |   204,800 |    131,072 | false / false / false | true      | true              | true |

These record observations from current code and discussions; before final Official Config release, capitalization, Context, and Output values still need verification against online Provider configurations and actual model services. General rules can first express Properties and Option Specs:

```json
[
  {
    "modelMatch": "GLM-5\\.3",
    "config": {
      "properties": {
        "contextWindow": 1000000,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["low", "high", "max"],
          "default": "max"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 128000,
          "max": 128000
        }
      }
    }
  },
  {
    "modelMatch": "GLM-5\\.2",
    "config": {
      "properties": {
        "contextWindow": 1000000,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["nothink", "high", "max"],
          "default": "max"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 131072,
          "max": 131072
        }
      }
    }
  },
  {
    "modelMatch": "GLM-5-Turbo",
    "config": {
      "properties": {
        "contextWindow": 204800,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["enabled", "disabled"],
          "default": "enabled"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 65536,
          "max": 131072
        }
      }
    }
  }
]
```

Z.AI, BigModel, and zcode-plan Builtin exact rules can override supportsNativeWebSearch to true; the field expresses the executable properties of the final Provider + Model combination.

## 6. GLM's Anthropic Messages Configuration

### 6.1 GLM-5.3

Standard Anthropic adaptive thinking + effort, no budget sent:

```json
{
  "modelMatch": "GLM-5\\.3",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "low": {
          "thinking": { "type": "adaptive" },
          "effort": "low"
        },
        "high": {
          "thinking": { "type": "adaptive" },
          "effort": "high"
        },
        "max": {
          "thinking": { "type": "adaptive" },
          "effort": "max"
        }
      }
    }
  }
}
```

### 6.2 GLM-5.2

`nothink` explicitly disables Thinking; other tiers use adaptive + effort:

```json
{
  "modelMatch": "GLM-5\\.2",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "nothink": {
          "thinking": { "type": "disabled" }
        },
        "high": {
          "thinking": { "type": "adaptive" },
          "effort": "high"
        },
        "max": {
          "thinking": { "type": "adaptive" },
          "effort": "max"
        }
      }
    }
  }
}
```

### 6.3 GLM-5-Turbo

Turbo preserves the fixed-budget compatibility behavior; 1024 comes from existing Anthropic fixed thinking's minimum budget compatibility and is not a new universal strategy:

```json
{
  "modelMatch": "GLM-5-Turbo",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "enabled": {
          "thinking": {
            "type": "enabled",
            "budgetTokens": 1024
          }
        },
        "disabled": {
          "thinking": { "type": "disabled" }
        }
      }
    }
  }
}
```

Turbo is not automatically changed to adaptive + effort, and 1024 does not spread to 5.2 or 5.3.

## 7. GLM's OpenAI Chat Configuration

OpenAI Chat compatible allows vendor request/response field extensions, so GLM's thinking, reasoning effort, and preserved thinking are explicitly described by `apiAdapter`. GLM-5.3 representative rule:

```json
{
  "modelMatch": "GLM-5\\.3",
  "apiMatch": "openai-chat-completions",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "low": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "low"
        },
        "high": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "high"
        },
        "max": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "max"
        }
      },
      "preserveThinking": true,
      "reasoningContentField": "reasoning_content"
    }
  }
}
```

GLM-5.2 also uses fixed replay configs, with nothink setting thinking.type to disabled. Turbo continues existing enable/disable dialects; formal parameter tables still need online verification.

preserveThinking is a fixed protocol config, not shown in the Composer and not freely modified by Binding:

```text
preserveThinking = true
        |
        +---- Requests write clear_thinking = false
        |
        +---- Responses read reasoning_content
        |
        +---- Tool Loop subsequent requests replay reasoning_content as-is
```

Only clear_thinking=false without complete replay would leave subsequent Tool Call requests without the model-required reasoning context. The old implementation enables reasoning_content compatibility by name for only some DeepSeek/MiMo models; the target implementation is driven by Model API Adapter Configs, exiting model name hardcoding.

## 8. OpenAI Responses

The OpenAI Responses protocol follows official reasoning item and effort semantics. GLM-5.2, GLM-5.3, and Turbo's exact support on Z.AI/BigModel Responses Endpoints is not yet verified online, so this draft fills in no speculative reasoningMapping. If a GLM Responses Endpoint is later confirmed to fully follow the official protocol, its rules save only the official effort mapping; preserveThinking and reasoningContentField are not copied to Responses configs.

## 9. Account Access and Request Authentication Boundaries

```text
Start Plan
├─ accessId fixes current account's Start Plan connection
├─ Request Auth obtains ZCode JWT
└─ Obtain one-time security verification Header per attempt as needed

Personal Coding Plan
├─ accessId fixes current account's personal connection
└─ Request Auth obtains current Runtime API Key

Team Plan
├─ accessId fixes account / organization / project
└─ Request Auth obtains current Project Runtime API Key
```

The Registry saves only Effective Provider Configs and final model configs. Models save the selected providerId, modelId, accessId, API, and Options at creation time. Each request can obtain updated credentials for the same connection; credential refreshes do not modify Model identities. Request Auth also verifies that credential-owned accounts match accessId — old Models cannot be combined with post-switch new account credentials.

## 10. Relationship with Existing Code

Pre-migration scattered facts: Builtin Provider IDs in `packages/shared/src/model-provider-types.ts`; Start/Coding Plan Endpoint fallbacks in `packages/services/src/model-provider`; GLM reasoning tiers and model-name judgments across shared, services, and CLI Adapters; reasoning_content replay still driven by model name lists in `apps/zcode-cli/packages/adapters/src/model/reasoning-content-compat.ts`; Anthropic fixed budget compatibility in `apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`; Native Web Search and MCS still partially inferred from Provider APIs, baseURL, and modelId.

During migration, judge each old fact for real production participation first: effective facts enter Official Configs or Adapter fixed protocol logic; ineffective models.dev/bundled catalog fields are not mechanically copied.

## 11. Still Needing Confirmation Before Publishing Official Config

1. Capitalization, Context, Max Output, and default output values ultimately adopted by GLM-5.3, GLM-5.2, and Turbo in Official Config.
2. BigModel Start Plan's final Endpoint, full model set, and relationship with Z.AI Start Plan.
3. Whether preserveThinking is fixed to true for all GLM OpenAI Chat Providers, or enabled by specific Builtin Provider rules.
4. Real model coverage and exact reasoning parameters for GLM OpenAI Responses.
5. Formal schemas for future non-Zhipu OAuth Access, and whether the same account access identity model is reused.

These do not overturn the layering that entered Design: Provider Config aggregates access and api, Model Config aggregates properties, optionSpecs, and apiAdapter, Account Access uses same-form Overlays, and dynamic request authentication stays at the request-period service.
