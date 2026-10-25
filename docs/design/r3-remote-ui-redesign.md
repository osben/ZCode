# Remote UI design entry point

The old device grouping, five-step wizard, four-state colors and manual model sync designs are retired. The
current contracts live in:

- [Connection UX](../architecture/remote-device-connection-ux-spec.md): three-screen wizard, unified five
  states, errors, device card, logs and accessibility.
- [Project navigation](../remote/project-first-remote-navigation-spec.md): flat projects, detail, in-place
  reconnect and navigation recovery.
- [Design guidelines](../../DESIGN.md): semantic tokens, font sizes, dimensions, themes and accessibility.
- [Provider Provisioning](../remote/provider-provisioning.md): local editing and automatic delivery; no remote
  model editing or manual sync entry.

The remote no-project chat UI is disabled; historical data is kept. Project online icons and the disconnected
state are shown neutrally, and "needs attention" uses the warning color; the full priority is maintained only
in the UX five-state table.

The prototype is not checked in and cannot serve as replayable verification evidence. The historical §20,
RUI-SIMPLE numbering, reviews and old open questions are in a pinned snapshot:

```bash
git show 45f808f7:docs/design/r3-remote-ui-redesign.md
```

Open items are tracked in the [R3 issue ledger](../architecture/r3-source-server-remote-open-issues.md); real
run and pending status are in the
[coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md).
