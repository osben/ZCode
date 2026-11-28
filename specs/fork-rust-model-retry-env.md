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
6. A server `Retry-After` is unchanged by this work: the wait is the larger of it and the local backoff, and a `Retry-After`
   above the limit (60 s, or the max delay when that is larger) ends the retries. Node accepts a `Retry-After` up to 5 minutes
   and treats a longer one as a local backoff; that difference is left open.

## Tests

- `crates/net/src/retry_tests.rs`: the delay by Node's formula (default, a custom factor, a cap, base 0, jitter range, jitter off).
- `crates/cli/src/assemble/options_tests.rs`: each variable, the parsing table of rule 2, independence of the four variables.
