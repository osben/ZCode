# Todo147: Generate test-account URLs from production config and admit test domains for signing

Status: implemented; focused verification and review completed. No request was sent to a real model service.

## Scope

- The production Built-in JSON is the only editable source. A script synchronizes and generates the test JSON by changing only the four account-Provider URL types and their corresponding site rules.
- Production site rules stay in the test config (manual templates still use them). Derived rules are generated per URL; capabilities and precedence are unchanged.
- Revision is kept synchronized. No user-config change, no online publish, no runtime URL rewriting.
- Two explicit z.ai test hostnames are added to signing; the existing `bigmodel.cn` match stays. Trial/off-peak access is not signed (no Sig). All other signing, authentication and header behavior is unchanged.

Detailed rules and commands: [two-environment build spec](../../../builtin-provider-config-build-environments.md).
This follows Todo146's "two initial copies are identical"; the test JSON is not maintained independently afterward.
The build consumes the generated files and does not silently rewrite them.

## Acceptance (all met)

- [x] Script generation is repeatable and leaves production sources unchanged; new models/capabilities sync; stale checks fail without writing files.
- [x] The eight account URLs in both real Release configs match valid config for their models; manual templates and other fields preserved.
- [x] Manual-key requests to test domains pass the same gate, same-origin handshake and Sig; fake domains, disabled gate and HTTPS boundaries covered.
- [x] Trial/off-peak requests for both providers use realistic JWT shapes on test domains and are not signed for streaming or non-streaming requests.
- [x] Relevant tests, types, lint, architecture and review complete; untested real environments identified.

## Verification (2026-09-14)

- 7 Node generation-contract tests and 13 existing build-contract tests pass (wrapped as Vitest cases). The SDK signing suite passes 70 tests; an injected local transport captured real SDK requests and asserted the same-origin handshake, final Sig and the test-domain JWT exception without real accounts.
- Test JSON differs from production only in eight account URLs and seven derived site rules; all built-in models of all eight accounts have matching effective test/production model config after fully decoding Release output.
- Root and adapters typechecks pass; root lint 0 errors / 42 existing warnings; architecture 0 violations; format passes on changed files.
- An additional `model-execution.test.ts` run: 31 pass, 3 pre-existing failures (reproduced with the execution file temporarily restored to HEAD): old tests expect official manual Keys not to be signed, and two Start/off-peak cases do not declare `accountMode` and are built as `api-key` by the fixture. The old tests and product were not changed. Package-wide adapters lint remains blocked by pre-existing max-lines violations in other unchanged files; changed files lint clean.
- No UI, user-data, message-sync or execution-authority change; no interaction E2E added; no real test-account network request or signed installer run.
