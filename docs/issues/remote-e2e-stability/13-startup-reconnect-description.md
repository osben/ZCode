# Auto-reconnect setting still describes the removed 7-day filter

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`. In batch `r3-server-20261011105317614-4a6780`
(`version-optional`) the run log read the visible Settings description “启动时静默重连最近 7 天内在线过的设备”
(silently reconnect devices that were online within the last 7 days). It is product copy, not a test-fixture
string.

The [current recovery contract](../../remote/desktop-remote-session-renderer-reattach.md) says all saved
connections are ordered by most recent online time and tried once each, with no 7-day filter; the global off
switch and the "only if credentials can be obtained silently" limit remain. The description therefore
misleads users into thinking devices older than 7 days are skipped.

Fix: change the text to the current scope and ordering rule and check both zh and en copy. Older R3 main
specs and the case catalog still list the 7-day item and should follow the recovery contract; product logic
must not return to the old filter. Not changed in this round.

This is an independent copy mismatch. The actual `version-optional` failure (update notice absent on first
read) is tracked separately in [issue 21](21-optional-update-notice-missing.md).

Supporting evidence: batch `r3-server-20261011125749338-152f05`, `recov/recovery-guards.json`: with
Source.lastOnlineAt set 8 days back, cold start produced a new remoteSessionId, hostCount=1 and
dialogShown=false, so the connection was not excluded by a 7-day filter. The case's later manual recovery
failed; only the reached cold-start stage is cited.
