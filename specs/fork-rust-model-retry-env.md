# zcode-rs model retry: the Node environment variables

Status: built 2026-11-27 (debt round). Node is the oracle: `apps/zcode-cli/packages/adapters/src/model/retry-policy.ts` (names,
parsing, defaults) and `runner-retry.ts` `calculateRetryDelay` (the delay). Node's own description is
`apps/zcode-cli/docs/design/v2/model/stream-error-retry.md`, "Environment variable overrides".

## Rules

1. Four variables, Node's names. `ZCODE_MODEL_RETRY_MAX_RETRIES` (retries after the first request), `ZCODE_MODEL_RETRY_BASE_DELAY_MS`,
   `ZCODE_MODEL_RETRY_BACKOFF_FACTOR`, `ZCODE_MODEL_RETRY_MAX_DELAY_MS`. They are read once, at composition
   (`cli/assemble/options.rs` `model_retry`), and shared by the app-server, the TUI and `-p`.
2. Parsing is Node's. An unset or blank value (after trimming) is unset. The text is read as a JavaScript `Number`: decimal and
   exponent forms, and the `0x`, `0o` and `0b` prefixes. Max retries, base delay and max delay take a finite number at or above 0
   and floor it. The backoff factor takes a finite number above 0 and keeps its fraction. Anything else (negative, `abc`,
   `inf`, `NaN`, `0` for the factor) is ignored and the default stays. A bad value never fails startup, and a bad value of one
   variable does not touch the others.
3. Defaults are Node's: 10 retries, base 2000 ms, factor 2, max delay 60000 ms. Before this change zcode-rs used 500 ms and a
   32 s cap with its own jitter.
4. No other bound. A base or max delay of 0 is allowed (the wait is 0). There is no upper limit, as in Node.
5. The wait before retry n (n from 1) is `min(base * factor^(n-1), max_delay)`. With jitter on (the default) a non-zero wait is
   multiplied by a random factor in `[0.5, 1.0)` and rounded to a millisecond, as in Node. The jitter never makes a wait longer
   than the cap.
6. Retry-After is Node's (`failure-inspection.ts` `parseRetryAfterMs`, `runner-retry.ts` `calculateRetryDelay`).
   - Headers: `retry-after-ms` first (a finite number, rounded to a millisecond, never below 0). Else `retry-after` as
     seconds (a finite number, times 1000, rounded) or as an HTTP date (the wait is the date minus now, never below 0). A
     value that is neither is ignored. `x-should-retry: false` or `0` (trimmed, any case) drops the Retry-After altogether:
     it is diagnostic only. Not matched: Node's `Date.parse` accepts more date spellings than the three HTTP-date forms
     zcode-rs reads, and its `Number` accepts hex in a header value.
   - Use: a Retry-After is honoured when it is at most 5 minutes, or when it is shorter than the uncapped backoff
     (`base * factor^(n-1)`, before the max delay). The wait is then the Retry-After itself, not the larger of it and the
     backoff, so a short Retry-After can be shorter than the local backoff. With jitter on, a forward-only extra of
     `random * min(20% of it, 5 s)` is added. A Retry-After that is not honoured is ignored and the local backoff applies.
   - There is no give-up on a long Retry-After: the retry count is the only limit. The old 60 s `max_wait` is gone from
     `RetryPolicy`. The workflow governor's own cooldown cap (60 s, divergence in 9.9) is a separate rule and is unchanged.
   - The 5-minute limit also caps the admission cooldown in Node's `applyAdmissionRetryCooldown`; that path is the
     governor's and is not part of this change.

## Tests

- `crates/net/src/retry_tests.rs`: the delay by Node's formula (default, a custom factor, a cap, base 0, jitter range, jitter off), the Retry-After rules of 6 (replaces the backoff, forward jitter, the 5-minute limit, `x-should-retry`).
- `crates/cli/src/assemble/options_tests.rs`: each variable, the parsing table of rule 2, independence of the four variables.
