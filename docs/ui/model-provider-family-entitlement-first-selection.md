# Model Provider Family Entitlement-First Selection

The right-hand detail of a Z.ai / BigModel provider family uses the `entitlement snapshot` as the primary
source for the connection mode. While family data is not ready, the UI shows loading instead of guessing
API Key, Start Plan, Coding Plan or Team Plan.

## Rules

1. Family detail waits for settings, the provider cache and the matching entitlement snapshot before
   rendering the final detail.
2. `UsageEntitlementSnapshot.context` names the plan context of the entitlement query:
   - `personal`: personal Coding / Start Plan quota.
   - `team`: BigModel Team Plan quota, carrying `organizationId` and `projectId`.
3. When the snapshot has a complete team identity, the Team Plan connection item is generated from the
   snapshot context first.
4. BigModel enterprise pricing / customerInfo only corrects or completes Team Plan metadata: display
   name, product ID, organization/project names, and subscribed projects the backend states exist but the
   snapshot does not cover.
5. Late correction data must not make an entitlement-derived Team Plan disappear, nor temporarily fall
   back to Coding Plan.
6. A settings read failure is an error state, not loading. The UI may show the existing
   connection-mode read-failure hint but must not infer another plan from it.

## Loading Boundary

Opening a Z.ai or BigModel family node keeps the existing loading card until:

- app settings finished the first read;
- model providers finished the first read;
- the current family's connection mode can be determined from settings and pending state;
- under OAuth mode, the current family provider's entitlement finished its first resolution or
  explicitly returned an entitlement error;
- the saved selected connection key resolves to a connection item, unless the key is no longer valid for
  the current family.

Custom providers and Add Provider do not use this family loading boundary.

## Context Hover Balance

"Today's balance" (今日余额) and "Remaining quota" (剩余额度) in the chat input context hover require all
three: the model provider actually in use belongs to the matching Plan provider; the current family
connection mode in Settings is the same mode; and the entitlement for that connection mode has displayable
benefits.

| Model provider in use         | Current connection mode | Entitlement state | Context hover shows        |
| ----------------------------- | ----------------------- | ----------------- | -------------------------- |
| API Key provider              | any                     | any               | neither balance nor quota  |
| Custom provider               | any                     | any               | neither balance nor quota  |
| Personal Coding Plan provider | Personal Coding Plan    | personal benefit  | Remaining quota (剩余额度) |
| Personal Coding Plan provider | Personal Coding Plan    | no personal       | nothing                    |
| BigModel Coding Plan provider | Team Coding Plan        | that team benefit | Remaining quota (剩余额度) |
| BigModel Coding Plan provider | Team Coding Plan        | no team benefit   | nothing                    |
| Start Plan provider           | Start Plan              | Start benefit     | Today's balance (今日余额) |
| Start Plan provider           | Start Plan              | no Start benefit  | nothing                    |
| Coding Plan provider          | API Key / Start Plan    | any               | nothing                    |
| Start Plan provider           | API Key / Coding Plan   | any               | nothing                    |

Implementation principles:

- The connection mode is read from `modelProviderFamilyModes` and `modelProviderFamilySelectedKeys`.
- The provider in use is resolved from the toolbar's current model value or supplier key.
- API Key and custom providers neither read nor show Plan balances.
- Personal Coding, Team Coding and Start Plan never back each other up; backend entitlement fills only
  the data of the current connection mode.
