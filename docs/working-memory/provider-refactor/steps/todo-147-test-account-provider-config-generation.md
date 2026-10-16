# Todo147: Generate Test-account URLs from Production Config and Admit Test Domains for Signing

Status: Implemented; focused verification and review completed. No request was sent to a real model service.

## Scope

- The production Built-in JSON is the only editable source. A script synchronizes and generates test JSON by changing only the four account-Provider URL types and their corresponding site rules.
- Keep production site rules in test config (manual templates still use them). Generate derived rules per URL; do not change capabilities or precedence.
- Keep the revision synchronized. Do not modify user config, publish online config, or add runtime URL rewriting.
- Add two explicit z.ai test hostnames to signing; keep the existing `bigmodel.cn` match.
- Do not send Sig for trial/off-peak access. Keep all other signing, authentication, and Header behavior unchanged.

See the [two-environment build Spec](../../../builtin-provider-config-build-environments.md) for detailed rules and commands. This decision follows Todo146's “the two initial copies are identical”; do not maintain test JSON independently afterward.

## Acceptance

- [x] Script generation is repeatable and leaves production sources unchanged; new models/capabilities sync; stale checks fail without writing files.
- [x] The eight account URLs in both real Release configs match valid config for their models; manual templates and other fields are preserved.
- [x] Manual-key requests to test domains pass through the same gate, same-origin handshake, and Sig; fake domains, disabled gate, and HTTPS boundaries are covered.
- [x] Trial/off-peak requests for both providers use realistic JWT shapes on test domains and are not signed for streaming or non-streaming requests.
- [x] Relevant tests, types, lint, architecture, and review are complete; untested real environments are explicitly identified.

## Verification and Review on 2026-09-14

- Seven Node generation-contract tests and 13 existing build-contract tests passed; both are included in routine regressions through Vitest wrappers.
- The SDK signing suite passed 70 tests. An injected local transport captured real SDK requests and asserted same-origin handshake, final Sig, and the test-domain JWT exception without using real accounts.
- Test JSON differs only in eight account URLs and seven derived site rules; production JSON is unchanged. After fully decoding Release output, all built-in models for all eight accounts have matching effective test/production model configuration.
- Root and adapters typechecks passed; root lint had 0 errors and 42 existing warnings; architecture had 0 violations; format checks passed on changed files.
- An additional `model-execution.test.ts` check had 31 passes and 3 pre-existing failures. Restored the execution file to HEAD temporarily (confirmed empty diff) and reran; the same three failed: old tests expect official manual Keys not to be signed, and two Start/off-peak cases do not declare `accountMode` and are actually built by the fixture as `api-key`. Those old tests were not changed, and the product fix was not broadened.
- Package-wide adapters lint remains blocked by pre-existing max-lines violations in other unchanged files; lint on changed files passed.
- No UI, user-data, message-sync, or execution-authority changes; no interaction E2E was added. No real test-account network request or complete signed installer was run.
- The build consumes generated files and does not silently rewrite them. Review found no unexpected changes to production config, templates, model rules, personal overlays, or signing-exception order.
