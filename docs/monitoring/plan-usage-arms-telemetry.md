# Plan Usage ARMS custom events

The ZCode desktop adds a request-level usage dashboard for all LLM requests through ARMS custom events.

## Event definition

| Field   | Value                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| group   | `plan_usage`                                                                                                                                                                   |
| name    | `plan_request` / `plan_ttft`                                                                                                                                                   |
| value   | `1` for `plan_request`; `ttft_ms` for `plan_ttft`                                                                                                                              |
| trigger | `plan_request` is reported when a real network state enters the live fact feed; `plan_ttft` is reported once the first-token time of a foreground local prompt can be computed |

The event does not wait for `message_completion` and does not copy the full `/event/report` completion payload.
`plan_request` is not tied to `send_btn`; it follows the five real states `model_request_started`,
`model_request_completed`, `model_request_failed`, `model_retry_scheduled` and `model_stream_stalled`, so it covers
real LLM requests in foreground and background. Initial, cold hydration and gap recovery produce no event, and the
event must not be inferred back from V4 `apiRetry`, accepted or queued projections. The client does not filter by a
provider allow-list; when the real state has no `provider_id`, `unknown` is used as fallback.

`plan_ttft` stays the renderer user-experience definition: from this renderer's desktop send seed to this renderer
receiving the first live text, reasoning or tool progress. Provider/runtime TTFT cannot replace it, and nothing is
back-reported after switching to background. The full lifecycle and multi-end boundary are in
[conversation-telemetry-v4.md](./conversation-telemetry-v4.md).

## Custom properties

| Property         | Description                                                                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_id`    | Provider id resolved at request time; built-in providers keep stable IDs (e.g. `builtin:zai` / `builtin:zai-coding-plan`), custom providers are fixed to `custom` |
| `provider_scope` | `builtin` / `custom` / `unknown`, determined together with `provider_id`                                                                                          |
| `model_name`     | Model id/name from the model request event; only built-in stable model IDs on the telemetry allow-list are kept, others are `custom`                              |
| `ask_mode`       | Query source from the model request event                                                                                                                         |
| `request_status` | `plan_request` only; `started` / `completed` / `failed` / `retry_scheduled` / `stream_stalled`                                                                    |
| `request_id`     | Model request id                                                                                                                                                  |
| `task_id`        | ZCode task id                                                                                                                                                     |
| `input_id`       | User input id                                                                                                                                                     |
| `query_id`       | Query id                                                                                                                                                          |
| `event_key`      | Protocol event de-duplication key                                                                                                                                 |
| `attempt`        | Current model request attempt                                                                                                                                     |
| `max_attempts`   | Maximum attempts                                                                                                                                                  |
| `ttft_ms`        | `plan_ttft` only; first-token latency in ms                                                                                                                       |

`provider_id` / `model_name` share one allow-list and normalization implementation of `@zcode/shared` with
`provider_id` / `model_id` of `chat_error_banner`: ids and model names of custom providers are named by users, so
reporting them raw would leak private names and create high cardinality; they are always normalized to `custom`.
Allow-list matching and output use normalized lowercase IDs. Normalization applies only to reported values; it
does not change the existing gate that sends no event when `provider_id` is empty, nor local logs or the business
provider selection.

Built-in providers have two sets of IDs: runtime IDs (`account:zai-start-plan` etc.) and legacy report identities
(`builtin:zai` / `builtin:zai-coding-plan` / `builtin:zai-start-plan` and the bigmodel counterparts). When the V4
supervisor projects the `/report` detail it already maps runtime IDs to legacy report identities, and `plan_ttft`
and `perf_ui_*` reuse the same detail, whereas `plan_request` uses the runtime ID from the protocol event
directly. The normalizer must therefore treat both ID sets as built-in and keep them as is, otherwise built-in
users would all fall into `custom`. `model_name` may be a `<providerId>/<modelId>` composite or a
`custom:<providerId>:<modelName>` encoding; normalization first strips out the bare model ID and then looks it up
in the allow-list.

The model allow-list is sourced from the official GLM model list of `@zcode/shared`
(`OFFICIAL_GLM_MODEL_IDS`) plus historical built-in models outside the official list; models added to the official
list join the allow-list and models not on it are written `custom`.

`provider_id=unknown` is the existing fallback bucket for "the protocol event carried no provider" and is not
merged into `custom`; under it `model_name` is judged by the model ID's own allow-list: kept if it hits the
built-in allow-list, otherwise `custom`.

The ARMS main-process bridge fills in `app_version`, `arms_env`, `device_mid`, `platform`, `renderer_id` and
`metric_value` automatically.

## Query suggestions

- Request volume: filter `group=plan_usage`, `event_name=plan_request`, group by `provider_id` / `model_name`.
- First-token latency: filter `group=plan_usage`, `event_name=plan_ttft` and look at the average and P95 of
  `value` or `ttft_ms`.
- Visiting users: after the same filter, use the ARMS correlated visiting users, or de-duplicate by
  `properties.device_mid` in log queries.
- Do not add this directly to `message_completion` of `/event/report`: they are different chains, the former being
  the ARMS request-level dashboard and the latter the business completion detail.
