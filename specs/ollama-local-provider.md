# Ollama local provider

Detect a local Ollama server from Model Settings, choose its chat models, and use them like any
other provider. Ollama serves an OpenAI-compatible API (`/v1/chat/completions`) next to its native
API (`/api/version`, `/api/tags`, `/api/show`).

## Decisions (user, 2026-10-25)

- Storage: the Ollama provider is a normal personal provider in `provider_config.json` with id
  `ollama`, `api.type = "openai-chat-completions"`, and `api.baseUrl = <server root>/v1`. This is
  valid for the upstream schema, so no fork sidecar is needed.
- Key: the provider config requires a non-blank API key; the provider stores the placeholder key
  `ollama`. Ollama ignores the Authorization header. The shared access schema is not changed.

## Product rules

- Settings → Model providers lists a **Local models** group (after Custom providers, before ACP
  agents) with one entry, **Ollama**, on every platform and in local and remote workspaces.
- The Ollama detail:
  - Server address: defaults to `http://127.0.0.1:11434`. Input is normalized to the server
    root: trimmed, trailing `/` and a trailing `/v1` removed; an address without a scheme gets
    `http://`. `localhost` is not rewritten (the user may rely on it), but the default uses
    `127.0.0.1` so IPv6 resolution cannot miss an IPv4-only server. Once the `ollama` provider
    exists, the address is the provider's `api.baseUrl` root and is edited in the provider's own
    settings; the field is read-only here.
  - Detect / Rescan: probes the server on the **host that owns the workspace** (a remote
    workspace probes the remote machine's own address). The Settings pane resolves the workspace's
    services for the probe (`useWorkspaceServices`, so a remote workspace's call routes to its
    host's services assembly); the provider mutations keep the local Host, because model
    configuration is a local global fact. Detection runs once when the detail opens and again on
    Rescan. Only the newest response writes state. Editing the address invalidates the previous
    result (and drops an in-flight probe): Save stays disabled until the address that is currently
    shown was detected, so a save never uses a root the input no longer shows.
  - Status: "Connected · Ollama <version> · <n> models" or "Not reachable: <reason>".
  - Model checklist: every model from `/api/tags`, labelled with its name, its parameter size and
    its context length. A checked model is in the provider. A model is selectable only when its
    capabilities include `completion` **and** `tools`; otherwise it is shown unchecked and
    disabled with the reason ("No tool support" / "Not a chat model"), because the agent always
    sends tools and the CLI refuses a model without tool support. A server that does not report
    capabilities (older Ollama) is treated as "unknown": the model is selectable, with a note.
  - Save: applies the checklist (see "Sync"). The button reads "Add to ZCode" while no provider
    exists and "Update models" afterwards; it is disabled while nothing changed.
  - "Open provider settings" selects the `ollama` provider under Custom providers, where models,
    context window and the address are edited like any custom provider.
- The `ollama` provider stays listed under Custom providers (it is an ordinary personal provider).
  The Ollama entry is the detector and model sync; the custom entry is its configuration.
- The Ollama entry's status dot is `ready` when the provider exists, is enabled and has at least
  one model; otherwise `disabled`.

## Sync (single write path, idempotent)

The Settings pane owns the sync; it uses only the existing provider-settings mutations, so there is
no new write path into `provider_config.json`:

1. No `ollama` provider: `createPersonalProvider({ providerId: "ollama", providerName: "Ollama",
initialConfig: { access: { type: "api-key", apiKey: "ollama" }, api: { type:
"openai-chat-completions", baseUrl: "<root>/v1" } } })` — one write.
2. For each checked model not in the provider: `addPersonalModel("ollama", name, config)` with
   `properties.supportsToolCall` from capabilities (true when unknown), `inputFormat.supportsImage`
   from `vision`, and `contextWindow` from `model_info.*.context_length` when reported.
3. For each provider model that is unchecked and was detected on the server:
   `deletePersonalModel("ollama", name)`. A provider model the server no longer reports is kept
   (the user may have pulled it on another machine, or added it by hand).

Writes run in that order, one at a time. A failure stops the sync, shows an alert and keeps the
checklist; running Save again computes the same plan from the current provider and finishes it
(every step is idempotent against the provider's current models). The checklist keeps the user's
requested set while a sync runs and after a partial failure — a provider view commit mid-sync must
not reset it — and re-derives from the provider only after a completed sync or a fresh detection.

## Detector (host RPC)

`IProviderSettingsService.detectOllama({ baseUrl? })` →
`{ reachable: true, baseUrl, version, models: OllamaModelSummary[] } | { reachable: false, baseUrl,
error }`, where `OllamaModelSummary = { name, parameterSize?, contextLength?, capabilities?:
string[] }` (`capabilities` absent = unknown).

- Read-only: never writes settings or files.
- `GET <root>/api/version` (2 s timeout), `GET <root>/api/tags` (3 s), then
  `POST <root>/api/show` with `{ "model": name }` per model (3 s each, at most 4 in flight). A
  failed `/api/show` leaves that model's details unknown; it does not fail detection.
- Uses the host's `fetch` (Node). It runs in the services assembly; the Settings pane calls it
  through the workspace's resolved services (`useWorkspaceServices`), so a remote workspace's
  probe reaches its own host while the provider mutations stay on the local Host.
- Logging: `info` once per detection with reachable/model count; never the address of a
  non-default server.

## Runtime notes and risks

- Model calls are made by the CLI on the host through the OpenAI-compatible adapter; request
  security passes loopback through. A configured HTTP proxy is used for `127.0.0.1` too unless
  `NO_PROXY` lists it (`apps/zcode-cli/packages/adapters/src/network/http-config.ts`); with a proxy,
  add `127.0.0.1` to `NO_PROXY`. The detail shows this hint when detection fails.
- Context: Ollama's OpenAI-compatible endpoint serves the server's configured context length
  (`OLLAMA_CONTEXT_LENGTH`), which can be smaller than the model's maximum that `/api/show`
  reports. The detail says so next to the checklist; the stored `contextWindow` is the model's
  maximum and can be lowered in the provider settings.
- Small models often handle tool calls poorly; this is not detected.
- The provider's models change only through Save (no live sync with `ollama pull`/`rm`).

## Owners and event order

| Fact                         | Owner                                              | Stored in              |
| ---------------------------- | -------------------------------------------------- | ---------------------- |
| Ollama server models         | the Ollama server (read by `detectOllama` on host) | not stored             |
| Detection result in Settings | `useOllamaDetection` (sequence-numbered)           | renderer memory        |
| Provider and its models      | provider settings service (existing mutations)     | `provider_config.json` |

```
Settings opens Ollama ─► detectOllama(seq n) ─► host fetch /api/version,/api/tags,/api/show
                                       ◄─ result(seq n)   (older seq dropped)
User checks models ─► Save ─► create? ─► add* ─► delete* ─► provider view commit ─► checklist
```

## Acceptance

| #    | Given                                         | When                       | Then                                                                                                             |
| ---- | --------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| OL1  | No server on the address                      | Ollama detail opens        | "Not reachable" with the reason; Save disabled                                                                   |
| OL2  | Server with `qwen3` (completion, tools)       | Detect                     | `qwen3` listed, selectable, unchecked                                                                            |
| OL3  | Server model with capabilities `["speech"]`   | Detect                     | Listed, unchecked, disabled, "Not a chat model"                                                                  |
| OL4  | OL2, no provider                              | Check `qwen3`, Save        | `provider_config.json` has provider `ollama` (placeholder key, `/v1` URL) with model `qwen3`                     |
| OL5  | Provider has `qwen3`, server still lists it   | Uncheck `qwen3`, Save      | `qwen3` is removed from the provider                                                                             |
| OL6  | Provider has `old`, server no longer lists it | Save                       | `old` is kept                                                                                                    |
| OL7  | Address `http://127.0.0.1:11434/v1/`          | Detect                     | Probes `http://127.0.0.1:11434/api/*`                                                                            |
| OL8  | A write fails mid-sync                        | Save                       | Alert; a second Save completes the remaining steps                                                               |
| OL9  | Two detections in flight                      | The older one settles last | The newer result stays                                                                                           |
| OL10 | Server A detected, a model checked            | The address is edited      | The result is dropped: Save disables until the new address is detected, and a save then uses that address's root |

Tests: detector unit tests with a fake fetch (normalization, unknown capabilities, `/api/show`
failure, unreachable, timeout); pure sync-plan tests (OL4–OL6, OL8); jsdom tests for the detail
(OL1–OL3, OL8–OL10); desktop E2E with a mock Ollama HTTP server on a random port (OL2, OL4, OL5).
Manual: a real round trip with a local tool-capable model.
