# Workspace sidebar customization

Workspace pins are owned by `ForkWorkspacePinRepo` in the shared tasks database. Its additive fork migration is identified in the shared migration ledger and must check the ledger and checksum inside the same `BEGIN IMMEDIATE` transaction that creates the table and records the migration. Concurrent window Hosts must safely converge on one migration row.

The UI loads pinned workspace keys before exposing pin and unpin actions. While the initial request is pending, users cannot mutate pin state from a stale empty snapshot. A failed request settles the loading state and leaves the list usable as unpinned.

Display names and icon colors are per-workspace preferences stored in the `zcode-workspace-display` localStorage record. A write reads the latest persisted record, changes only the target workspace entry, and publishes the merged state to the current store. Other open windows reload this record when they receive its `storage` event.

Pressing Enter saves the customization dialog only when the input method is not composing a candidate. E2E scenarios that require the two-workspace startup fixture must be registered in both the full warmup fixture list and the small two-workspace list.
