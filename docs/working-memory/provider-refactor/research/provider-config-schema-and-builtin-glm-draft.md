# Provider Config Schema and Builtin GLM Draft

> Status: Config structure has entered Design; this document preserves GLM API facts and pre-release verification items
>
> Record Date: 2026-08-18
>
> Scope: Provider Config, Model Config Rules, Account Access, GLM-5.2, GLM-5.3, and GLM-5-Turbo

This draft saves the structures converged in this round of discussion, and the parts still needing code and online behavior verification. It is used to avoid losing context in subsequent discussions; implementation and reviews follow the formally accepted conclusions in Design.

## 1. Currently Converged Overall Shape

The Provider Registry's static facts consist of three layers of the same-form Provider Config Overlays:

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

Each layer is responsible for:

- Official saves product-managed Providers, model members, model public properties, and protocol configurations.
- Personal saves user-created Providers, and explicit overrides to Official Providers.
- Account Access publishes currently available Account Providers, model subsets, and access identities based on the current account, plan, and connection state.

Official and Personal are persistent. Account Access is an in-memory runtime Overlay. Request authentication materials like Login Tokens, Runtime API Keys, and one-time security verification Headers do not enter these three layers, nor the Registry.

Provider configs and model configs are two complementary data sets:

```text
Provider Config
└─ How to connect, how to obtain access资格, which modelIds to include

Model Config Rules
└─ Properties, Option Specs, and protocol behavior for modelId
```

## 2. Provider Config Schema Draft

This round splits a Provider's "access eligibility" and "request protocol" into two orthogonal dimensions. They aggregate in the same ProviderConfig but each uses Schemas with discriminant fields.

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

The outer ProviderConfigMap's key is providerId, so values do not redundantly save providerId. All fields remain optional, enabling the same type to express either a sparse overlay layer or the post-override result. Missing fields mean inheriting from previous layers; null means this layer explicitly clears the field.

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

The current formal scope covers api-key and zhipu-account. Future vendor OAuth and other access methods will extend new Access branches when concrete needs arise.

apiKeyManagementUrl is the product information for the settings page to jump to the vendor's Key management page. It is explicitly provided by Provider Config, not inferred from baseURL.

Zhipu Account's accessId identifies a specific account connection, not just a Plan type. It remains stable when the same account refreshes Tokens, Runtime Keys, or Headers; it must change when switching accounts. The accessId is fixed after Model creation; the request auth service can refresh credentials for that connection, but will not silently switch a running Model to another account or another personal/team connection.

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

External Config uses `api.type`. Adapter types are implementation details chosen by the Model construction chain based on API configs, not entering user configs.

Currently only Provider-level static Headers are retained. Model-level Headers and arbitrary model.options do not enter the new config contract. OpenAI-compatible streaming request `include_usage` is fixed by the Adapter to open, and is also not exposed as a config item.

### 2.3 Completeness

Each overlay layer can be sparse. After covering, the Registry only accepts Providers that form complete connections:

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

Completeness is checked by Config Classes recursively. The Settings Facade uses the same check results to display fields needing completion; the Registry filters incomplete configs without copying a separate judgment.

## 3. Model Config Rules

Model configs are a set of ordered rules. Each rule contains match conditions and a sparse ModelConfig. Later hit rules continue to override earlier results.

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

providerMatch, modelMatch, and apiMatch use the same pattern matching semantics. Rules execute sequentially, with later hits continuing to Overlay earlier results.

A model's general fields and protocol fields are contributed by different rules:

```text
modelMatch = GLM-5.3
└─ Properties + Option Specs

modelMatch = GLM-5.3, apiMatch = anthropic-messages
└─ Anthropic reasoning mapping

modelMatch = GLM-5.3, apiMatch = openai-chat-completions
└─ OpenAI Chat reasoning mapping + preserved thinking replay
```

### 3.1 Properties

Current common Properties include at least:

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

supportsNativeWebSearch can be affected by Provider Endpoint capabilities, so generic model rules can provide conservative values, and Builtin Provider exact rules contribute the final values. supportsMidConversationSystem is recorded as true for the current three GLM models.

### 3.2 Option Specs and Options

Option Specs declare user-selectable common options and defaults. Options save the actual selections bound to a Model instance.

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

API Adapter Config saves the fixed adaptation behavior of the current model under a specific public API.

```ts
class ModelApiAdapterConfig extends ConfigOverlay {
  reasoningMapping?: ReasoningMapping | null;
  preserveThinking?: boolean | null;
  reasoningContentField?: string | null;
}

type ReasoningMapping = Record<string, ReasoningParameters>;
type ReasoningParameters = Record<string, unknown>;
```

reasoningMapping maps common reasoningLevel to protocol-required parameters. preserveThinking and reasoningContentField only appear in protocols that truly have that semantics.

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

OpenAI Chat Compatible dialects are the most complex, so reasoningMapping and reasoning replay primarily function under this protocol. Anthropic Messages and OpenAI Responses should prioritize following their respective public protocol's fixed semantics.

## 4. Provider Type Examples

The following JSON expresses only target structures. Field content comes from current discussions and existing code, and is not yet a directly publishable final Official Config.

### 4.1 Ordinary API Key Provider

Official can provide an as-yet-unconnected vendor entry point, with Personal filling in API Keys; users can also create Providers entirely in Personal.

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

BigModel API Key Providers use the same structure, with the current Anthropic Endpoint at https://open.bigmodel.cn/api/anthropic.

### 4.2 Start Plan

Start Plan's Official Config saves static connections:

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

Account Access generates same-form Overlays based on login and plan results:

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

The models here are the current account's permitted subset. ZCode JWTs and one-time security verification Headers used during requests are obtained by the request auth service.

BigModel Start Plan uses providerId builtin:bigmodel-start-plan. It currently shares zcode-plan request semantics with Z.AI Start Plan; final Endpoints and the full model set need to be aligned with remote Official Configs.

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

Account Access determines which Coding Plan Providers are truly published in the current Family, and fills in accessIds and model subsets. The request auth service then obtains the current valid Runtime API Key using accessId.

### 4.4 Team Plan

Team Plans can currently reuse Coding Plan providerIds. Account Access uses different accessIds to fix organization, project, and connection identities:

```text
personal coding plan
└─ zhipu-account:<account-id>:coding-plan:builtin:zai-coding-plan

team plan
└─ zhipu-account:<account-id>:team-plan:builtin:zai-coding-plan:<product>:<org>:<project>
```

Provider Configs and Model Configs do not copy Team secrets. The request auth service obtains the corresponding Project Runtime Key based on accessId. If products decide to simultaneously publish Personal and Team optional connections in the future, whether ModelSelection needs to carry connection identity becomes independent design; M2 first maintains each Provider Family publishing only the current active connection.

### 4.5 Temporary Providers

Idle task and other execution-scoped scenarios can attach a temporary Provider Config in Submissions. It does not write to Official, Personal, or persistent Registries:

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

Temporary Providers use the same ProviderConfig, Model Config, and Model construction chain. After task completion, the temporary resolution scope naturally releases, without needing to modify or restore Session's persistent model selections.

## 5. GLM Model Common Configurations

The following attributes are GLM common facts provisionally set this round:

| Model       |   Context | Max Output | Image/PDF/Video       | Tool Call | Structured Output | MCS  |
| ----------- | --------: | ---------: | --------------------- | --------- | ----------------- | ---- |
| GLM-5.3     | 1,000,000 |    128,000 | false / false / false | true      | true              | true |
| GLM-5.2     | 1,000,000 |    131,072 | false / false / false | true      | true              | true |
| GLM-5-Turbo |   204,800 |    131,072 | false / false / false | true      | true              | true |

These values record observations from current code and discussions. Before final Official Config release, capitalization, Context, and Output values still need verification against online Provider configurations and actual model services.

General rules can first express Properties and Option Specs:

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

Z.AI, BigModel, and zcode-plan Builtin exact rules can override supportsNativeWebSearch to true. This field expresses the executable properties of the final Provider + Model combination.

## 6. GLM's Anthropic Messages Configuration

### 6.1 GLM-5.3

GLM-5.3 uses standard Anthropic adaptive thinking + effort, not sending budget:

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

GLM-5.2's nothink explicitly disables Thinking; other tiers use adaptive + effort:

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

Turbo currently preserves the fixed-budget compatibility behavior. 1024 comes from existing Anthropic fixed thinking's minimum budget compatibility and does not represent a new universal strategy:

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

This round does not automatically change Turbo to adaptive + effort, nor does it spread 1024 to 5.2 or 5.3.

## 7. GLM's OpenAI Chat Configuration

OpenAI Chat Compatible allows vendor-request and response field extensions. GLM's thinking, reasoning effort, and preserved thinking are therefore explicitly described by `apiAdapter`.

GLM-5.3 representative rule:

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

GLM-5.2 also uses fixed replay configs, with nothink tier setting thinking.type to disabled. Turbo continues existing enable/disable dialects; formal parameter tables still need verification against online behavior.

preserveThinking is a fixed protocol config. It does not appear in the Composer and is not freely modified by Binding:

```text
preserveThinking = true
        |
        +---- Requests write clear_thinking = false
        |
        +---- Responses read reasoning_content
        |
        +---- Tool Loop subsequent requests replay reasoning_content as-is
```

Having only clear_thinking=false without complete replay would cause subsequent Tool Call requests to lack model-required reasoning context. The current old implementation only enables reasoning_content compatibility by name for some DeepSeek/MiMo models; the target implementation should be driven by Model API Adapter Configs, exiting model name hardcoding.

## 8. OpenAI Responses

The OpenAI Responses protocol should follow official reasoning item and effort semantics. GLM-5.2, GLM-5.3, and Turbo's exact support scope on Z.AI/BigModel Responses Endpoints has not yet been verified online, so this draft does not fill in a speculative reasoningMapping.

If a GLM Responses Endpoint is later confirmed to fully follow the official protocol, corresponding rules only need to save its official effort mapping; preserveThinking and reasoningContentField should not be copied to Responses configs.

## 9. Account Access and Request Authentication Boundaries

The three types of Account Providers have different dynamic materials:

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

The Registry only saves Effective Provider Configs and final model configs. Models save the selected providerId, modelId, accessId, API, and Options at creation time. Each request can obtain updated credentials for the same connection; credential refreshes do not modify Model identities. Request Auth also verifies that credential-owned accounts match accessId, and cannot combine old Models with post-switched new account credentials.

## 10. Relationship with Existing Code

Current implementations still have scattered facts in multiple locations:

- Builtin Provider IDs are in packages/shared/src/model-provider-types.ts.
- Start Plan and Coding Plan Endpoint fallbacks are in packages/services/src/model-provider.
- GLM reasoning tiers and model-name judgments are scattered across shared, services, and CLI Adapters.
- reasoning_content replay is still driven by model name lists in apps/zcode-cli/packages/adapters/src/model/reasoning-content-compat.ts.
- Anthropic fixed budget compatibility boundaries are located in apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts.
- Native Web Search and Mid-conversation System are still partially inferred based on Provider APIs, baseURL, and modelId.

During migration, each old fact should first be judged for whether it truly participates in current production behavior. Truly effective facts enter Official Configs or Adapter fixed protocol logic; ineffective models.dev/bundled catalog fields are not mechanically copied.

## 11. Still Needing Confirmation Before Publishing Official Config

The following issues remain as draft boundaries:

1. Capitalization, Context, Max Output, and default output values ultimately adopted by GLM-5.3, GLM-5.2, and Turbo in Official Config.
2. BigModel Start Plan's final Endpoint, full model set, and relationship with Z.AI Start Plan.
3. Whether preserveThinking is fixed to true for all GLM OpenAI Chat Providers, or enabled by specific Builtin Provider rules.
4. Real model coverage and exact reasoning parameters for GLM OpenAI Responses.
5. Formal schemas for future non-Zhipu OAuth Access, and whether the same account access identity model is reused.

These issues do not overturn the main layering that has entered Design: Provider Config aggregates access and api, Model Config aggregates properties, optionSpecs, and apiAdapter, Account Access uses same-form Overlays, and dynamic request authentication stays at the request-period service.
