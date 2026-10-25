# No progress card on the main view after minimizing the connection wizard

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, patch 09, batch `r3-server-20261011150809016-2aeaba`;
`three-screen` failed after 141.0 s. A separate TCP target accepted the connection and stalled in the
handshake; clicking "收起" (minimize) returned to the main view with the project area visible, yet after 5 s
there was still no `remote-connection-minimized`. The video shows the normal main view and project rows, which
excludes the mistake of looking for a sidebar card only on the Settings page.

The [three-screen wizard contract](../remote-connection-ux/10-three-screen-wizard-and-selection.md) requires
persistent progress in the project area after minimizing, with failures retained and the wizard restorable.
`RemoteConnectionMinimizedProgress` returns null when there is no `slot.container`; the Slot definition and
Root provider remain in source, but no mount of `RemoteConnectionProgressSlot` in the current project sidebar
was found.

```text
connection pending → minimize wizard → back to project area
  → no progress container registered → no progress card and no restore entry for it
```

Business code is unchanged. This does not show the connection was cancelled; the later "background failure
retained, restore view, no duplicate dial" assertions are not reached. The walkthrough case's background
progress segment shows the same gap and must be recorded as a segment failure.

Evidence: failure video and log of `three-screen`; patch 08's walkthrough `index.json` keeps the failed
background progress segment.
