export type AccountProviderCredentialScope = {
  readonly providerId: string;
  readonly accountIdentity: string;
} & (
  | { readonly planKind: "start-plan" | "individual-coding-plan" }
  | {
      readonly planKind: "team-coding-plan";
      readonly productId: string;
      readonly organizationId: string;
      readonly projectId: string;
    }
);

/**
 * Private physical key for the Credential Store.
 *
 * The old account identifier served as both Config identity and credential-cache key, spreading account identity
 * into Provider, Protocol, and UI. The physical key now stays within the Services credential boundary that owns account identity.
 */
export function accountProviderCredentialKey(input: AccountProviderCredentialScope): string {
  const providerId = required(input.providerId, "Provider ID");
  const accountIdentity = required(input.accountIdentity, "账号身份");
  const scope =
    input.planKind === "team-coding-plan"
      ? [
          "team",
          providerId,
          required(input.productId, "Team Product ID"),
          required(input.organizationId, "Team Organization ID"),
          required(input.projectId, "Team Project ID"),
        ]
          .map(encodeURIComponent)
          .join(":")
      : `${input.planKind === "start-plan" ? "start-plan" : "coding-plan"}:${providerId}`;
  return `account-provider:${scope}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Account Provider 缺少${label}`);
  return normalized;
}
