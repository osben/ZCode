# Workspace restore entry after a device comes online

The old sidebar device group header and connect-and-chat UI were replaced by the [flat project navigation](../remote/project-first-remote-navigation-spec.md). An entry with a directory restores the original project; a manual connection without a directory asks for a directory after it succeeds. When credentials, install or upgrade are needed, the single wizard takes over and keeps the original intent. Presentation depends only on the [unified five states](remote-device-connection-ux-spec.md); the old four states and the pending->offline rule are gone.

## C3 Device-online restore gate

The effective rule now lives in [Renderer re-attach](../remote/desktop-remote-session-renderer-reattach.md). At cold start the Host picks silent-connect candidates by each device's `lastOnlineAt` within the last 7 days. After a device is online, the Renderer re-attaches all open, disconnected, stable-identity projects of that Source in the current window; it does not filter again by workspace age or last connected state. Same-cycle dedupe, terminal close, explicit disconnect and late-result boundaries are maintained by that spec.

The historical RDUX-12/13/14 numbers are regression IDs of the old device group header and are not the later UX implementation tickets with the same numbers. Do not replace the current navigation acceptance with old connect-and-chat assertions. Original root-cause log, change list and test record:

```bash
git show 45f808f7:docs/architecture/remote-device-sidebar-device-level-connect-spec.md
```

Host gate, data format and the desktop continuous / mobile replayable semantics are unchanged.
