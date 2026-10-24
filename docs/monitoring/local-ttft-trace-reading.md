# How to read a local TTFT trace

Status: ready

[Parent contract](ttft-stage-telemetry.md) · [Query and diagnostics contract](local-ttft-queries.md) · [Dashboard template](dashboards/local-ttft.json) · [Rollout checklist](local-ttft-rollout-checklist.md)

For someone opening a `zcode-local-ttft` waterfall for the first time. Query entry points and metric definitions
are in the query contract; this document only explains how to read one Trace into a conclusion.

## Three basics

**1. `duration` is in nanoseconds.** A root span showing `701699951` is **701.70 ms**, not 700 million. For raw
fields always use `duration / 1000000`.

**2. One message is a whole span tree, not one record.** One send has dozens of spans in the same trace; the
`observation_id` without hyphens is the trace ID.

**3. The conclusion is in the root span's `attributes` field.** It is a JSON blob, not predefined columns;
`select attributes.observation_id` in SQL fails with "Column cannot be resolved", so use a full-text search on the
value instead.

## Span naming

| Span name shape                  | What it is                                              | Represents duration        |
| -------------------------------- | ------------------------------------------------------- | -------------------------- |
| `local_ttft`                     | Root: total TTFT of one send, exactly one per message   | Yes                        |
| `local_ttft.<main stage>`        | One of the six main stages                              | Yes                        |
| `local_ttft.prepare.<sub-stage>` | A breakdown inside request preparation                  | Yes                        |
| `local_ttft.attempt`             | One physical model request                              | Yes                        |
| `local_ttft.retry_wait`          | Wait between two attempts                               | Yes                        |
| `local_ttft.user_confirmation`   | User dwell time in the queue second-confirmation dialog | Yes (but not system time)  |
| `local_ttft.checkpoint`          | In-progress state snapshot; one message may have dozens | **No**                     |
| `local_ttft.start`               | Start marker at submit time                             | **No**                     |
| `<any>.started`                  | Point record that the stage started but has not ended   | **No**                     |
| `local_ttft.first_text`          | Independent observation of the first text               | Yes, but not the main TTFT |
| `local_ttft.no_text`             | The whole turn ended without any text                   | No                         |

Before reading the waterfall, filter out `checkpoint`, `start` and `.started`; what remains are the duration
intervals. A `.started` duration of 0 does not mean the stage took zero time; it means no end boundary arrived.

## Six main stages

In real time order; boundary definitions are in the
[parent contract's stage and time contract](ttft-stage-telemetry.md#stage-and-time-contract).

| Stage               | What happens in this time                                                              | If large                                    |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `renderer_prepare`  | UI receives click/Enter, passes the send gate and assembles the command                | Local processing delay before sending       |
| `command_admission` | Command reaches the CLI and is authoritatively accepted, including admission-gate wait | Communication delay or admission contention |
| `execution_wait`    | Accepted, waiting for this input's turn to execute                                     | Other work is queued ahead                  |
| `request_prepare`   | Execution starts: hooks, context loading, persistence, compaction, request assembly    | Expand `prepare.*` to see which item        |
| `model_request`     | Request sent until the CLI forms this input's first valid output                       | Count `attempt`s to tell slow from retried  |
| `output_return`     | First output travels from the CLI via Host back to the originating UI                  | Return-path bottleneck                      |

## Example: a real sample

`observation_id = 820f1085-7bf1-4b04-9229-c2625b11da47` (2026-09-15 platform-acceptance sample, 62 spans).
**This is an E2E replay sample; its command delay and first-text delay were injected on purpose by the test and do
not represent online performance.**

```text
0        7.5                        303   310        383            669    701.7 ms
├────────┼──────────────────────────┼─────┼──────────┼──────────────┼──────┤
│renderer│   command_admission      │exec │ request  │ model_request│output│
│_prepare│        295.48            │_wait│ _prepare │    285.38    │_return
│  7.50  │                          │6.77 │  73.81   │              │32.75 │
└────────┴──────────────────────────┴─────┴──────────┴──────────────┴──────┘
   ↑                                                                    ↑
 send clicked                                                  first output seen
```

The six segments sum to 701.69 ms against the root's 701.70 ms: that is what `unattributed_ms=0` means. **The
total duration is fully explained, no time is unaccounted for.** When it is not 0, the difference is unattributed
time and must not be forced onto the model or network.

Inside `request_prepare`'s 73.81 ms: `prepare.context` 10.48, `prepare.hooks` 5.86, `prepare.persistence` 3.21,
`prepare.request_assembly` 3.82, `prepare.mcp` 0.14, `prepare.tools` 0.10. Sub-stages summing to less than the main
stage is normal; the unbroken-down part is not zero-filled.

`local_ttft.attempt` 285.39 is about `model_request` 285.38: only one request was made. With retries you see several
`attempt`s plus `retry_wait`.

## Main TTFT and first text are different things

In the same sample `local_ttft.first_text` = **8450.50 ms**, more than ten times the root. It is not a
contradiction: the root's `first_output_kind = reasoning`, so at 0.7 s the user saw reasoning content and the real
text answer only came at 8.45 s.

Total TTFT alone would say the experience is great; `first_text` shows the user waited 8 s to see the answer. Count
them separately and never substitute one for the other.

## Root attributes checklist

| Attribute           | Value in this sample  | How to use                                                                                                                                 |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality`           | `complete`            | Only `complete` enters the complete stage distribution; `missing` is missing/expired calibration, `clock_invalid` a detected clock anomaly |
| `visibility`        | `background_returned` | The default experience uses only `foreground`; this sample went to background mid-way and came back                                        |
| `send_mode`         | `idle`                | Group `idle`/`queued`/`guided` separately, never mix them                                                                                  |
| `first_output_kind` | `reasoning`           | Whether the first output was text, reasoning or a tool call                                                                                |
| `unattributed_ms`   | `0`                   | Unattributed time; reconciled against the **union** of reliable intervals, parallel time counts once                                       |
| `clock_error_ms`    | `5.02`                | Cross-process alignment error, threshold 10 ms                                                                                             |
| `truncated`         | `false`               | Whether truncated by a capacity limit                                                                                                      |
| `missing_stages`    | empty                 | Which stages are missing; missing does not mean the stage took 0                                                                           |

Correlation IDs (`command_id`/`input_id`/`query_id`, `turn_id`, `product_turn_id`, `logical_call_id`, `request_id`,
`cli_instance_id`) only link Traces and never enter metric labels. `request_id` changes on retry and is not the
primary key of a whole send.

## Locate by symptom

Look first at the root's total duration and `first_output_kind`, then at which main stage dominates:

- Large `command_admission`: command delivery or CLI admission contention, not a slow model.
- Large `execution_wait`: business queueing; combine with `send_mode=queued` to judge whether it is normal.
- Large `request_prepare`: expand `prepare.*`; commonly hooks or context loading.
- Large `model_request`: count `attempt`s: one slow request, or several failed retries accumulating.
- Large `output_return`: the return path.
- Large `user_confirmation`: the user dwelt in the confirmation dialog, not system processing time.

## Unclosed is not failed

A record with only `local_ttft.start` and some `checkpoint`s and no root span is **unclosed**: it may still be
running or may have lost its terminal.

- `interrupted` requires explicit exit or interrupt evidence; items still without a result after the 5-minute
  observation cleanup stay `unclosed`.
- A query window not covering the first submit makes the start/end sets inconsistent; that is window truncation,
  not a timeout.
- Never read the count difference between `start` and terminals as a timeout rate.

## Common misreadings

- Treating `checkpoint` or `.started` as a duration stage.
- Treating `first_text` as TTFT, or looking only at TTFT and ignoring first text.
- Treating the number of `attempt` or `prepare.*` intervals as the number of user messages.
- Adding the durations of parallel sub-stages as the main stage's wall time.
- Adding P95s of different stages, or deriving other stages as total P95 minus model P95.
- Mixing `background` / `background_returned` / `quality != complete` samples into default experience statistics.
- Blaming the `unattributed_ms` difference on network or model.
