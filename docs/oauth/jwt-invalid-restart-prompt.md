# ZCode JWT Invalid Prompt and Restart

When the Host detects a 401 response to a ZCode JWT request through the unified `NodeApiClient`, it
first reuses OAuth logout to clean local credentials, then notifies the Renderer by broadcast. The
Renderer shows a unified AlertDialog saying "Login has expired"; after the user confirms, it writes
a one-time restart marker and executes `RelaunchApp`. The new Renderer consumes and deletes the
marker on startup and is forced onto the login page with reason `session-expired`.

```text
401 + Current ZCode JWT
        ↓
Host logout cleans credentials and derived providers
        ↓
auth:zcode-jwt-invalid broadcast
        ↓
Renderer AlertDialog
        ↓ User confirmation
Write one-time restart marker
        ↓
Electron RelaunchApp
        ↓
Consume marker and enter login page
```

The same flow is reused when current-platform userinfo/customerInfo, enterprise pricing and team
subscription detail requests carry the current business access_token and return HTTP 401 or
HTTP 200 + JSON numeric `code: 401`; see [401 Auto-Logout](jwt-401-auto-logout.md) for the exact
scope. Empty responses, other business errors, regular API Keys and payment/API key management
requests are not part of this judgment. The Web side has no `RelaunchApp`: after confirmation it
writes the marker and calls `location.reload()`, and consumes the marker after the refresh to
enter the `session-expired` login page.
