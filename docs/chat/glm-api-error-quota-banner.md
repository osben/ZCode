# GLM API Error Quota Banner (V4, pending migration)

The old path offered model-settings, upgrade or recovery CTAs for GLM quota/API errors. The current V4 composer uses the generic `ChatErrorBanner` and has not yet reconnected those dedicated CTAs and suppression rules.

Current behavior: show the generic error from the projection and allow local dismiss. The dedicated quota experience named in the title is not promised. A future implementation must use structured fault codes and provider/entitlement state, not error-text matching.
