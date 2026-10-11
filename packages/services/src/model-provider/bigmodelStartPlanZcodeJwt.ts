import { BIGMODEL_PROVIDER_ID } from "@zcode/shared";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

interface BigModelStartPlanZcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

export async function resolveBigModelStartPlanZcodeJwt(params: {
  credentialService?: BigModelStartPlanZcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedZcodeJwt?: boolean;
}): Promise<string> {
  const activeProvider = (await params.credentialService?.load(ACTIVE_PROVIDER_KEY))?.trim() || "";
  if (params.trustCachedZcodeJwt === true || activeProvider === BIGMODEL_PROVIDER_ID) {
    const credentialJwt = (await params.credentialService?.load(ZCODE_JWT_TOKEN_KEY))?.trim() || "";
    if (credentialJwt) {
      return credentialJwt;
    }
  }

  // The zcode JWT must be persisted from the authorization-code body during the BigModel OAuth callback.
  // Start Plan balance queries and runtime only consume the saved JWT or a provider copy. They must not
  // build a provider+access_token body from the BigModel access_token for an ad hoc exchange, which would cause /oauth/token to return 400.
  return params.provider?.apiKey?.trim() || "";
}
