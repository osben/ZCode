# Built-in Default Configuration

`config/default.json` is the default configuration distributed with the client and must be retained. Desktop reads it from the packaged file; Web imports it at build time. If a remote request fails or lacks valid fields, the built-in values are used.

## Help Configuration Sources

The community and feedback entry points in the current release request `GET /api/v1/client/configs` from the current endpoint and read `data.configs.feedbackUrl`:

- `community_urls["zh-CN" | "en-US"]`: Fall back to the built-in entry for the current language only; do not fall back across languages.
- `feedback_url`: Use the remote URL if valid; otherwise use the built-in URL.
- `feedback_use_external_form`: Prefer the remote boolean value; `false` is a valid override too.

The request includes `app_version`. Desktop also sends `platform-arch`; Web omits the platform parameter. Successful responses are cached in memory for one hour only. Requests use `cache: no-store`, and failures are not cached.

```text
current endpoint client/configs -> valid help fields -> platform entry point
                  | missing / failure
                  v
          built-in default.json -> platform entry point
```

`default.json` is a built-in default configuration distributed with the client. It was previously distributed through a CDN and is retained only for compatibility with older clients. The current version has no request or URL-construction path and relies only on the built-in file in this directory; all other fields remain unchanged for existing consumers.

See [Community Entry Point Configuration](../docs/ui/settings-community-link-config.md) for details.
