# Provider name editing during refresh

The provider card owns the unconfirmed name draft. Refreshing the same provider must
preserve the open name editor, its value and IME composition. Other clean connection
fields still receive refreshed values. Switching provider identity cancels the old
name edit and resets its composition state; unconfirmed text is never saved to the
new provider.

Acceptance: start editing before typing, refresh the same provider with a different
name and endpoint, and verify the name draft stays while the endpoint updates. Also
verify typed drafts, explicit Enter/Escape and provider identity changes.
