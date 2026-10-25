# Model Provider Enablement Header

On the model provider detail page, the enablement status and the enable/disable action share one title
row.

- The status badge follows the provider name.
- The "Enable / Disable" button follows the status badge, kept apart from the secondary actions on the
  right.
- The right action area keeps only non-toggle actions such as view usage and delete.

Implementation:

- `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- `packages/ui/test/modelProviderEnablementHeader.test.ts`
