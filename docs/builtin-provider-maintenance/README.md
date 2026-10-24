# Built-in Provider Template and Model Maintenance

This directory is the day-to-day entry for maintaining built-in Provider templates, model members and model rules. The maintenance goal is to keep covering mainstream vendors and mainstream coding and Agent models, with every configuration backed by a source, validation and a delivery record.

It organizes the existing contracts and maintenance flow. Additions within scope and the existing protocols proceed directly; changing, disabling or deleting existing configuration is discussed and confirmed first. The Google native protocol is postponed for the short term; the exact boundary is in the scope principles. The baseline is staging `68fac8de4fcc` of 2026-10-14, Builtin revision 33. Later configuration MRs must update the current state in this directory.

This directory provides on its own the background, concepts, rules, rationale and steps that maintenance needs, without requiring other docs to be read first. Links inside the directory expand explanations; code links verify the implementation; official-source links check dated external evidence. Valid conclusions from historical material are folded into the body, and unimplemented proposals are explicitly kept as candidates.

## Start from a task

| What to do | Entry |
| --- | --- |
| Decide which vendors and models to maintain, how to extend and retire | [Scope and principles](./scope.md) |
| Understand templates, members, rules, parameter maps and production/test configuration | [Configuration spec](./configuration.md) |
| See current templates, the full model list, default enablement and known gaps | [Current state](./current-state.md) |
| See the latest expansion advice, rule differences and batch plan | [2026-10-14 expansion plan](./expansion-plan.md) |
| Keep tracking news, official catalogs and retirement notices | [Research tracking and findings](./research.md) |
| Move from a candidate to a configuration MR, assign manual collaboration | [Maintenance workflow](./workflow.md) |
| Obtain API keys, run real validation, leave reviewable evidence | [Validation spec](./validation.md) |
| Merge MRs, ship with a version, go live dynamically and roll back if needed | [Delivery spec](./delivery.md) |

## Fact boundaries

- **Configuration facts**: `config/provider/zcode-builtin.json` is the production edit source; the test configuration is derived by script. Schema, Resolver and Adapter define what can actually be expressed and executed.
- **Maintenance decisions**: this directory records the integration scope, priority, default enablement and operating rules; additions within the confirmed scope proceed directly; adjusting or deleting existing entries is discussed first; proposals beyond current protocol capability stay as candidates.
- **Validation facts**: the repository has the configuration, the vendor has documentation, one account can call it, and the client has shipped it are four different things. None substitutes for another.
- **History vs. present**: [Current state](./current-state.md) records this baseline and known differences, and the [Configuration spec](./configuration.md) explains the current rules and trade-offs. When an old list or historical to-do conflicts with the code, re-verify; do not restore old configuration automatically.

The unit of model maintenance is **vendor product entry x original model ID x API protocol**. Different plans of one brand, one model through different aggregating entries, and one endpoint with different protocols cannot share one validation conclusion.

## Done conditions

A configuration maintenance item is done when the scope is confirmed, production/test configuration share one source, the related checks pass, real validation and gaps are explicit, and the MR merge and delivery state are traceable. Without a key one may continue research, add tests and prepare the MR, but the pending manual validation state must stay; it must not be written as usable or live.

Fixed-account Providers share Release, model rules and environment conversion with ordinary templates. This directory explains the account entitlements, configuration ownership and effect boundaries that maintenance must preserve; developing the account login product, session system and remote-control protocol is outside template maintenance.
