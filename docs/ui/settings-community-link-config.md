# User Community Entry Configuration

The help menu's "User community" entry and the platform "Feedback" action both read from the current
endpoint's `client/configs.data.configs.feedbackUrl`; the built-in `config/default.json` provides
defaults. Historical acceptance counts from earlier staging are not counted as passing for this change;
integration evidence is kept in `todo103-staging-integration-ledger.md` (no Provider/Selection boundary
change).

## Config Format

```json
{
  "feedback_url": "https://example.com/feedback",
  "community_urls": {
    "zh-CN": "https://example.com/zh-community",
    "en-US": "https://example.com/en-community"
  }
}
```

## Resolution Rules

1. Current language `zh-CN`: read remote `zh-CN`, then built-in `zh-CN`.
2. Current language `en-US`: read remote `en-US`, then built-in `en-US`.
3. If neither remote nor built-in has an entry for the current language, the UI hides "User community".

Languages never fall back to each other, so Chinese users do not land on Discord nor English users on
Feishu.

```text
switch language
   |
   v
click User community
   |
   +--> remote current language --> built-in current language --> hide entry
                                          |
                                          v
                                       open entry
```

## Current Defaults

- `zh-CN`: Feishu add-friend link `https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&qr_code=true`
- `en-US`: Discord invite `https://discord.gg/z9aBcQXZQ3`

## Implementation Locations

- Shared parsing: `packages/shared/src/remoteAppConfig.ts`
- Desktop platform resolution and local config fallback: `packages/desktop/src/main/desktopCommandHandlers.ts`
- Web platform resolution: `packages/web/src/communityUrl.ts`
- Help menu display: `packages/ui/src/WorkspaceHelpMenuButton.tsx`

## client/configs Source (2026-09)

Help config reads `GET /api/v1/client/configs` of the current endpoint with the existing `app_version`
and `platform` parameters, strictly validates `code=0`, then reads `data.configs.feedbackUrl`, which
contains `community_urls`, `feedback_url` and `feedback_use_external_form`. The old CDN file is kept for
old clients; built-in `config/default.json` is kept (Desktop ships it with the package, Web imports it at
build time).

```text
visibility check / click entry
          |
   platform-injected HTTP request (no-store, 10 s timeout)
          |
   in-memory cache per endpoint + version + platform (1 hour / concurrent coalescing)
          |
   code=0 -> feedbackUrl -> resolve per field
          |
   valid remote value -> built-in same-language default -> hide community / do not open an address-less form
```

1. The common reader writes no disk HTTP cache, localStorage or database. Help config is a public
   request with no user auth; the cache is isolated by the full request URL and failures are not cached.
2. Switching endpoint during a request must not write the old result into the new endpoint's cache.
3. Missing fields, invalid types and empty links fall back; boolean `false` is a valid override.
4. The desktop native help menu and command palette keep choosing the built-in dialog or the external
   form by the switch; the question-mark menu and the Windows custom-drawn menu still open the built-in
   form directly. Web's platform feedback action still opens the external address.
5. Web uses the same deployment endpoint config as OAuth / relay and adds no remote-control RPC, Host or
   Agent; the desktop continuous / web remote replayable session chains are unchanged.

Runtime finding: the server rejects `platform=web` (HTTP 400 / code 3001); Web omits the optional
`platform` and the production endpoint returns HTTP 200 / code 0. Desktop keeps platform-arch.

Verification: unit tests cover envelope, field and language fallback, `false` override, HTTP/JSON/timeout
failure, concurrent coalescing, TTL and endpoint isolation; interaction tests cover the community
external link and the platform feedback action; typecheck and lint are required with runtime request
evidence. 36 unit tests passed, and macOS Electron HC-01 passed (mocked new endpoint, community external
link, no-store request option, `false` not opening the external form, switching endpoint then `true`
opening the given feedback form). Windows/Linux and real mobile browsers were not run; Web is covered by
request-parsing unit tests and the real endpoint. A cross-origin custom Web endpoint still needs server
CORS, otherwise the built-in defaults apply. Do not run E2E in parallel with typecheck (`out/host` can be
overwritten); interaction assertions wait for the actual external-link call.

### Old CDN Path Cleanup

The old CDN address constants and versioned URL builders are no longer exported and their stale unit
tests are deleted. Field-parsing functions still used in `remoteAppConfig.ts` and their tests stay. The
built-in `config/default.json` content and the Desktop/Web packaging are unchanged; the online old CDN
file still serves old clients. Formal HC-01 to HC-05 (8 cases) keep covering the new path.
