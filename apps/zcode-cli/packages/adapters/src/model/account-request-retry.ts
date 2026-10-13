import type { RequestVerificationReason } from "@zcode/shared";
import { projectAccessTokenFingerprint, isRequestSecurityFailure } from "@zcode/shared";
import type { Logger, ModelRequestAuth } from "@zcode/contracts";
import { zhipuAccountMode } from "./account-access-mode.js";
import { RequestVerificationRetry } from "./request-security-edition/recovery.js";
import { inspectProviderFailure } from "./failure-classifier.js";
import {
  getApiCallResponseBody,
  getHttpResponseStatus,
  unwrapRetryError,
} from "./failure-inspection.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";

export class AccountRequestRetry {
  readonly #verification: RequestVerificationRetry;
  #used = false;
  #pending = false;
  #auth?: ModelRequestAuth;

  constructor(
    private readonly request: AiSdkModelTextRequest,
    private readonly model: ResolvedAiSdkModel,
    private readonly logger?: Logger,
  ) {
    this.#verification = new RequestVerificationRetry(request, model);
  }

  get extraAttempts(): number {
    return this.#verification.extraAttempts + Number(this.#used);
  }

  takeReason(): RequestVerificationReason {
    return this.#verification.takeReason();
  }

  prepareRequest(request: AiSdkModelTextRequest): AiSdkModelTextRequest {
    const refresh = request.refreshRuntimeHeadersBeforeAttempt;
    if (!refresh) return request;
    return {
      ...request,
      refreshRuntimeHeadersBeforeAttempt: async (input) => {
        const previous = this.#auth;
        const recover = this.#pending;
        this.#pending = false;
        this.#auth = undefined;
        const token = previous && this.#token(previous);
        const result = await refresh({
          ...input,
          ...(recover && token && previous?.accountScope
            ? {
                expectedAccountScope: previous.accountScope,
                rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint(token),
              }
            : {}),
        });
        if (recover && result.requestAuth?.accountScope !== previous?.accountScope)
          throw new Error("project_token_scope_invalidated");
        this.#auth = result.headersApplied ? result.requestAuth : undefined;
        return result;
      },
    };
  }

  claim(error: unknown, blocked = false): boolean {
    if (this.#verification.claim(error, blocked)) return true;
    if (!this.canRecoverProjectToken(error, blocked)) return false;
    this.#used = true;
    this.#pending = true;
    this.logger?.warn(
      this.model.accountAccess?.type === "chatgpt-account"
        ? "ChatGPT plan token rejected; refreshing once before retry"
        : "Model PAT rejected; refreshing once before retry",
      {
        event:
          this.model.accountAccess?.type === "chatgpt-account"
            ? "model.siwc_token.refresh_retry"
            : "model.project_token.refresh_retry",
        providerId: String(this.model.providerId),
        modelId: String(this.model.modelId),
        traceId: this.request.traceContext?.traceId,
        statusCode: 401,
      },
    );
    return true;
  }

  canRecoverProjectToken(error: unknown, blocked = false): boolean {
    const mode = zhipuAccountMode(this.model.accountAccess);
    const isChatgptPlan = this.model.accountAccess?.type === "chatgpt-account";
    if (
      blocked ||
      this.#used ||
      this.request.abortSignal?.aborted ||
      !this.request.refreshRuntimeHeadersBeforeAttempt ||
      !this.#auth?.accountScope ||
      !this.#token(this.#auth) ||
      !isProjectTokenRejection(error)
    )
      return false;
    if (isChatgptPlan) {
      // SIWC: a 401 (signed identity not accepted / subscription_sharing_invalid_user) gets one
      // token refresh + retry; a terminal refresh failure is surfaced by the resolver instead.
      return true;
    }
    return ["individual-coding-plan", "team-coding-plan", "off-peak"].includes(mode ?? "");
  }

  #token(auth: ModelRequestAuth): string | undefined {
    return zhipuAccountMode(this.model.accountAccess) === "off-peak"
      ? Object.entries(auth.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "x-coding-plan-api-key",
        )?.[1]
      : auth.apiKey;
  }
}

export function isProjectTokenRejection(error: unknown): boolean {
  return (
    getHttpResponseStatus(unwrapRetryError(error)) === 401 &&
    !isOtherAuthRejection(error, new WeakSet<object>())
  );
}

function isOtherAuthRejection(error: unknown, seen: WeakSet<object>): boolean {
  const current = unwrapRetryError(error);
  if (!current || typeof current !== "object" || seen.has(current)) return false;
  seen.add(current);
  const details = inspectProviderFailure(current);
  return (
    isRequestSecurityFailure(getApiCallResponseBody(current), [
      details.providerErrorCode,
      details.providerErrorMessage,
    ]) ||
    ("cause" in current && isOtherAuthRejection(current.cause, seen))
  );
}
