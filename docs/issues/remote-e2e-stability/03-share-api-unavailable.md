# Intermittent Failures of the Production API for SSH Artifact Sharing

Status: needs-triage

## Confirmed Run Facts

Business baseline `54ece08f23f79ae54aea1f51e0d941497d627392`, same-source production build, using a verified real account. Desktop generated `report.html` on the Source through an official SSH connection; the file contains a test marker, and publishing was confirmed through the product UI.

- `r3-server-20260924090435267-55e0c4` published successfully; the public preview and the downloaded file both passed the assertions.
- `r3-server-20260924091406992-dde620` and `r3-server-20260924091613035-7dbace` failed independently, with the artifact uploaded and stopping at the checking stage.
- `r3-server-20260924093538609-e2bdb1` succeeded again, showing it is not a permanently unusable account or a missing remote file.
- `r3-server-20260924094553403-374a70` failed again. A read-only observation of Node HTTP diagnostic events of this case's dedicated Source Core recorded the production `POST /api/v1/shares/preparations/<id>/confirm` returning **HTTP 503** with a JSON response. Request ID `20260924094737fb81e1d45bbdf211785c`, response observed at `2026-09-24 09:48:07.717 UTC`.

HTTP evidence: safe-field record (`packages/desktop/.e2e-artifacts/remote-stability-20260924/share-http-observation2.jsonl`); stages of the two independent failures: first (`packages/desktop/.e2e-artifacts/remote-stability-20260924/share-final-1.json`), second (`packages/desktop/.e2e-artifacts/remote-stability-20260924/share-final-2.json`). The observation did not modify requests or responses and kept no auth headers or bodies; the observing process was recycled with the case container.

## Boundary and Remaining Investigation

This failure has a real server 503 and cannot be attributed to a WDIO wait timeout, nor hidden by automatic retries. The backend root cause of the 503 is not yet determined and needs the share service or upstream logs by request ID. The earlier two checking failures and an even earlier uploading failure did not collect the HTTP status, so they cannot all be asserted to share the cause. The UI shows only the failing stage and "服务端未返回可定位详情" (the server returned no locatable detail), with no usable request ID; the diagnosability of the error still needs investigation.

The test now waits for both success and an explicit failure terminal state and records the stage, copy and duration on failure at once; success still requires byte reconciliation of the download. The two checking failures reached a terminal state in about 12.5 seconds each, avoiding the old logic's unconditional idle 120-second wait. No business or server code was modified.

Reproduction entry: in an independent production build deployment directory, run `node harness/remote/run-queue.mjs share` with `R3_BUILD_ENV=production R3_LIVE_HOME=<account material HOME>`. Keep each independent result; successful rounds alone must not be summarized.
