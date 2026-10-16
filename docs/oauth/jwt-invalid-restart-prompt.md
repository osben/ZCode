# ZCode JWT Invalid Prompt and Restart

When the Host detects 401 responses from ZCode JWT requests through the unified `NodeApiClient`, it first reuses OAuth logout to clean local credentials, then notifies the Renderer via Broadcast. The Renderer displays a unified AlertDialog prompting "Login has expired"; after user confirmation, writes a one-time restart marker and executes `RelaunchApp`. When the new Renderer starts, it consumes and deletes the marker, forcing entry to the login page with `session-expired` reason.

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

When current platform userinfo/customerInfo, enterprise pricing, and team subscription detail requests carry the current business access_token and return HTTP 401 or HTTP 200 + JSON numeric `code: 401`, the same flow is also reused; see [401 Auto-Logout](jwt-401-auto-logout.md) for specific scope. Empty responses, other business errors, regular API Keys, payment/API key management requests are not included in the new judgment. The Web side has no `RelaunchApp`; after user confirmation, writes the marker and calls `location.reload()`, consuming the marker after refresh to enter the `session-expired` login page.
