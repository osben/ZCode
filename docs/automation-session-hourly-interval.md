# Session-side Cron interval tasks (`intervalUnit` / `interval`)

## Goal

When a chat session creates or modifies an "every N minutes/hours/days/weeks/months/years" task via `CronCreate` or `CronUpdate`, it uses the same scheduling semantics as the scheduled-tasks UI's custom repeat (「自定义重复」):

- Units: `minute`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`.
- `interval` must be an **integer from 1 to 200**; `0`, negatives, fractions, and values above `200` are rejected at the contract, protocol, and service boundaries.
- The real repeat semantics come from the persisted `scheduleRule`; `cronExpr` is only a legal compatibility expression and must not let cron field step limits change the real frequency.
- `CronList`, `CronCreate`, and `CronUpdate` responses must return `scheduleRule`, so session cards show the real frequency instead of misreading the compat cron as "hourly".

The UI custom repeat's input range and semantics are the source of truth: `docs/ui/scheduled-tasks-main-view.md`.

## Root cause

A standard five-field cron caps field steps: 59 for minutes, 24 for hours, 31 for days, 12 for months. So these are invalid:

- every 61 minutes: `*/61 * * * *`
- every 31 hours: `49 */31 * * *`
- every 32 days: `0 9 */32 * *`
- every 13 months: `0 9 15 */13 *`

Writing an over-limit interval into cron directly makes the service reject the task at `isValidCronExpr`; silently converting it to a per-minute/per-hour cron would change the task's frequency.

## Controlled input model

The Cron tools keep `cron` and add a paired optional pair:

```ts
intervalUnit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
interval: 1..200;
```

`intervalUnit + interval` expresses the UI's custom-repeat semantics; the model must not submit the internal `scheduleRule` directly.

### Usage rules

1. When the user says "every N units", the tool must submit **both** interval fields, even when `N` happens to be expressible as cron (for example every 20 hours). This advances by `scheduleRule.anchorAt` like the UI's custom repeat, instead of degrading to wall-clock cron.
2. `cron` stays required; it fixes the time-of-day, weekday, day-of-month, or month inside the compat expression. It must be a legal five-field cron and serves only as the `scheduleRule` display/compat carrier.
3. The carrier cannot be combined with the one-shot relative delays `delayMinutes` / `relativeDelayMinutes`.
4. The carrier combines with existing `recurring` / `maxRuns`: it only defines "how the next run is computed"; finite run counts stay under the existing lifecycle rules.
5. Plain cron without the carrier keeps the old semantics, so existing absolute-date, weekday, or calendar tasks are unchanged.

### Legal compat cron

The service executes the real interval from `scheduleRule`; callers only provide a legal cron without out-of-range steps:

| Real semantics                | carrier           | Legal compat cron example |
| ------------------------------ | ----------------- | ------------------------- |
| every 200 minutes              | `minute`, `200`   | `* * * * *`               |
| every 31 hours at minute 49    | `hourly`, `31`    | `49 * * * *`              |
| every 40 days at 09:00         | `daily`, `40`     | `0 9 * * *`               |
| every 8 weeks Mon/Wed/Fri 09:00| `weekly`, `8`     | `0 9 * * 1,3,5`           |
| every 13 months on day 15 09:00| `monthly`, `13`   | `0 9 15 * *`              |
| every 2 years on Jun 15 09:00  | `yearly`, `2`     | `0 9 15 6 *`              |

## Data flow

```text
CronCreate / CronUpdate
  { cron, intervalUnit, interval }
             |
             v
contract + protocol
  pair + 1..200 + recurrence invariant validation
             |
             v
Host AutomationService
  buildIntervalScheduleRule(intervalUnit, interval, cronExpr, Date.now())
             |
             +--> scheduleRule       (authoritative real schedule)
             +--> cronExpr           (legal compat/display)
             |
             v
computeScheduleRuleNextRunAt(scheduleRule)
             |
             v
persist / return scheduleRule
             |
             v
session card describeAutomationCardSchedule
  reads scheduleRule first, shows the real "every N units"
```

## Multi-client and old-Host boundaries

This extends only the existing app ↔ agent automation protocol; desktop continuous and mobile remote replayable session message paths are unchanged. Remote workspaces keep using their existing host attachment.

When an old Host's strict schema does not recognize the new fields, the request must not degrade to a plain cron create — that would write a real 31-hour/40-day frequency as hourly/daily. Such requests must fail with an explicit "Host does not support the interval carrier" error. Old `CronCreate`/`CronUpdate` without the carrier stays compatible.

## Verification requirements

1. Contract/protocol: `1` and `200` valid; `0`, `201`, fractions, missing pair fields, and mixing with relative delays invalid; finite-run tasks may carry the carrier.
2. Cover the full contract → port → protocol → Host → service passthrough for both create and update.
3. Cover at least `61/200` minutes, `25/200` hours, `32/200` days, `13/200` months, `2/200` years; every compat cron passes cron validation and the next run time comes from the real `scheduleRule`.
4. Create/Update/List responses all return `scheduleRule`; the session success card shows the real frequency.
5. Regression-check the UI custom repeat `1–200` bounds and the compat cron for intervals over cron field limits.
