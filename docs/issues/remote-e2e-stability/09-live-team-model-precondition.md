# Local Precondition for the Real Team Model Verification Is Not Ready

Status: needs-info

## Current Record

- Business baseline `a13999a28927f629d0c64080a5096cf8b4f23bae`, production build.
- Case `conversation-session-r3-live-bigmodel-team.test.ts`, batch `r3-server-20261009234650716-227ddc`, task `live-team`.
- The real login material and Team connection selection were imported into an isolated HOME; the current OAuth contract does not copy old-account API Keys.
- Before connecting SSH, the local model menu was checked first, and `account:bigmodel-team-coding-plan / GLM-5.3-Flash` selected by this case did not appear. The case explicitly returned `BLOCKED_ACCOUNT 本机真实账号的 Team 模型未就绪` (the Team model of the real local account is not ready).
- `localAccountModelUnavailable=true` in `live-team.json` records this control-group failure. This round did not complete a real Team model request, so it cannot be attributed to an SSH regression and cannot be replaced by a replay.

## Precondition to Supply

Verify the model availability of the current real account/project and whether the designated model still applies, then run the same real-request case. This round the real API Key representative `live-zapi` passed; Personal model sync, defaults and offline fill-in have separate passing evidence.
