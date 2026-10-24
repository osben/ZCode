# message_completion provider_name

`message_completion` previously reported only `model_provider`, which for custom providers is an
internal provider id or uuid and cannot be analyzed by real request hostname.

## Rules

- Keep `model_provider` for existing data-warehouse compatibility.
- `provider_name` is new: the hostname of the provider endpoint only — no protocol, path, query,
  header or API key.
- The initial send snapshot parses the hostname from the current provider registry endpoint
  `baseURL`.
- On `model_request_started`, if the event carries `baseURL`, the snapshot is overwritten with the
  hostname of the real request `baseURL`.
- `send_btn` and `message_completion` share one prompt telemetry extraDetail; first send, follow-up
  and queued sends all carry the same initial `provider_name` snapshot in the send event.
- When the URL cannot be parsed, leave the field empty; never report an internal uuid or raw
  endpoint as hostname.

## Scope

UI telemetry extraDetail only; the app-agent protocol and task flow are unchanged. Desktop
continuous and mobile web-remote replayable share the same prompt telemetry state, and
`provider_name` reports as a plain dimension on the existing `message_completion`.
