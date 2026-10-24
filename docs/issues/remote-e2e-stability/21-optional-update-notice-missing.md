# Compatible-version connection shows no deferrable update notice on the device card

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`; `version-optional` failed after 214.2 s. The version fixture uses the
full current runtime and only changes the compiled version and compatibility metadata; it does not represent a
real future implementation.

## Facts

Initial install `3.15.1`; fixture installed as `3.16.0`, minimum=`3.15.0`. After connecting, A/B restored new
attachments and the remote stayed `3.16.0` (no forced downgrade). For 30 s the device card showed only
connected, SSH, original A/B projects and disconnect/edit/log entries: no update notice and no "later" button.
`version-policy.json` holds both restoredProjects and the full optionalPanelText; a too-early single-frame read
on Settings mount is excluded. The deferral and Settings-remount dedupe assertions are not reached.

```text
compatible higher Server version → original A/B restored → open remote device settings
  → card still has no update notice after 30 s → "later" and dedupe unverifiable
```

## Contract and boundary

The [device card update contract](../remote-connection-ux/13-settings-device-cards-and-updates.md) requires an
optional update to use a neutral banner with "稍后 / 更新" (Later / Update) and no toast. The compatibility
check records a differing but compatible endpoint as an optional update; with this fixture's version relation
the update direction is the desktop, so it must not claim the remote must upgrade. The settings card code has
an `upgradeTarget=controller` branch, but the page received or showed no matching state. The projection from
connection compatibility state to the device card still needs locating; business code is unchanged, and
normally restored projects are not recorded as connection failures. See also
[issue 23](23-desktop-upgrade-guidance-missing.md).

Evidence: `version-policy.json`, run log and failure video of `version-optional`.
