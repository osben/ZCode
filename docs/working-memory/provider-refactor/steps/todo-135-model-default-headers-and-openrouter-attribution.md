# Todo135: Restore default model-request headers and OpenRouter attribution

Status (2026-09-12): implementation, item-by-item review and local verification done. No joint real
desktop/phone/SSH acceptance was run and no request was sent to an external model service.

## Goal and root cause

Restore two behaviors dropped by the Provider refactor: the generic default headers of actual model
requests, and the OpenRouter-specific attribution headers. Title generation was the reported entry, but
the fix is at the common model outlet, not a title-only patch. Baseline: `origin/main`
`e7921fb5d484d9c9d22d2e638064163fd13143a6`.

- The old `createDefaultProviderHeaders()` merged source info and site attribution when constructing the Provider, then let user headers override.
- Current `model-execution.ts` `toAiSdkProviderConfig()` copied only `config.api.headers`, so common model requests lacked default source info.
- The source builder `buildCliZCodeSourceHeaders` still exists, but business `NodeApiClient`, the security-signing switch query and route-config query are not the path of actual model SDK requests and are no equivalent substitute.
- `withOpenRouterAttributionHeaders()` still exists, but the CLI source builder passed `undefined` so OpenRouter never matched.
- Account auth, custom headers, request security signing and tracing have separate implementations and were not lost; the `X-Client-Version` sent on successful signing does not replace a client-version declaration on all model requests.

## Contract

- Bootstrap reuses `buildCliZCodeSourceHeaders` to build the execution environment's `defaultHeaders`, passed through the existing Execution Config -> Model Adapter -> Model Execution. The Provider Registry is not read to infer the runtime environment.
- When Model Execution binds a Model it merges the existing OpenRouter default attribution for this Provider Base URL, then user headers. Default config, Provider config and bound Models are never mutated in place afterward.
- Header merge reuses one case-insensitive override function (extracted from the request-auth algorithm, shared by defaults, user values and request auth); request-time auth still overrides last the headers it owns; request security validation, tracing and runtime refresh are unchanged.
- Desktop local injects the client version via `ZCODE_APP_VERSION`; the remote launch command passes the same variable; the protocol entry passes `sourceTitle: electron` explicitly. The env var keeps priority over the Worker's own version; standalone CLI keeps its existing version/source assembly.
- No state sync, cache, IO, protocol or persistence change; desktop continuous / mobile replayable remain on the original chain. Title, Wiki, subtask and connection test consume the common model factory; no business-side header patching.

### Generic default headers

| Category       | Restored default content                                                 |
| -------------- | ------------------------------------------------------------------------ |
| Client version | `User-Agent: ZCode/<version>`, `X-ZCode-App-Version` for a valid version |
| Product source | `HTTP-Referer`, `X-Title: Z Code@electron/cli`, `X-ZCode-Agent: glm`     |
| Environment    | `X-Release-Channel`, `X-Client-Language`, `X-Client-Timezone`            |
| Platform       | `X-Platform`, `X-Os-Category`, `X-Os-Version`                            |

Never mistake the SDK version or a remote Worker's own version for the desktop client version. Value
normalization and missing-value semantics are kept (no illegal newlines in headers; a normal version is
actually sent, never silently `unknown`). Runtime-environment headers are not written into Built-in /
Personal config and need no data migration. `X-Device-Mid` (supported by the shared builder) is out of
scope and not sent to third-party model services.

### OpenRouter attribution

Reuse the existing URL matcher with the actual configured Provider Base URL (never display name or
Provider ID). On match add `X-OpenRouter-Title: ZCode` and `X-OpenRouter-Categories: programming-app`;
non-OpenRouter gets none. The existing HTTPS and domain/subdomain boundary is kept (tests: official domain,
subdomain, fake suffix, non-HTTPS). The invalid Bootstrap call passing `undefined` was removed.

### Composition

```text
runtime environment -> generic default headers + site default attribution
  -> Provider user headers override
  -> existing request auth / tracing / security signing
  -> SDK final network request
```

Default source and site headers may be explicitly overridden by the user (case-insensitive, no duplicate
concatenation). Existing auth, signing and request ownership authority, order and degradation rules are
unchanged. No change to account sync, model selection, UI, request body or desktop/mobile semantics;
phone still reuses the shared-host chain.

## Review result

- Call chain: production `new AiSdkModelAdapter` exists only in Bootstrap `model-factory.ts` (assembled in `create-app.ts`); main session and child runtimes reuse it. The title sidecar uses `createRuntimeModel`; Wiki and connection test go session facade -> workspace runtime -> the same factory. No production bypass needs business-side headers; an alternative ModelAdapter injected by a caller stays the caller's responsibility.
- Title: the real `AgentRuntime.maybeStartSessionTitleGenerationFromExternalInput` -> sidecar -> Model -> real SDK -> injected fetch capture asserts original title prompt, title write-back, version, other type, Session/Trace headers.
- Version ownership: desktop `desktopRuntimeEnv.ts` injects the version, SSH `remote/connect.ts` passes it, the protocol entry is explicitly electron, standalone CLI uses the original source detection. Tests confirm the client env version beats the Worker version; OS info still denotes the actual executing machine, same as main.
- Architecture: infrastructure config flows along the original Bootstrap -> Adapter boundary; module is legacy/unmanaged `zcode-cli`; no new module, state owner, cache, notification or protocol. Untouched: real accounts, user config, databases, model selection, request body, security signing and degradation policy.

## Verification (baseline `27eba110b4`)

Wire tests written first failed on the old implementation (no ZCode version / OpenRouter headers).
Bootstrap wire/source/Registry/runtime headers: 6 files 39 passed (20 new final-request tests); Adapter
header/auth/binding/model request: 5 files 55 passed (2 new merge/bind tests); manual Coding Plan signing
and endpoint routing: 2 files 47; Desktop env, remote launch command, OpenRouter matching: 3 files 43
passed (4 macOS-only skipped on Linux). Root typecheck, Bootstrap typecheck, Adapter build and strict
test type checks passed; root lint 0 errors / 42 existing warnings; CLI changed files linted with a
temporary config keeping the same max-lines and test exceptions (0 warnings/errors; repo lint config not
changed); architecture 0 violations. Bootstrap tests use the Adapter package export, so the Adapter is
built first to avoid an old dist. Signing tests use different fake keys to isolate the process-level
switch cache. Logs are `/tmp/todo135-*.log`.

Limits: no real Electron, phone shared-host, SSH-workspace model request or Windows/macOS full-machine
verification; env-passing cases and injected-transport SDK requests prove the code chain only. This item
does not authorize publishing online config, changing real user data or auto-pushing.
