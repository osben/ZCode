import type {
  AccountAccessIdentityInput,
  AccountRequestAuthInput,
  AccountRequestAuthMaterial,
  AccountRequestAuthResolver,
} from "./accountProviderRequestAuthService.js";
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";

/**
 * Request-time Account authentication boundary.
 *
 * The service resolves request credentials from the current account connection under the Active Model's static family/mode constraints.
 * It does not store Provider Config or provide a Registry fallback.
 */
export interface IAccountRequestAuthService {
  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial>;
  assertCurrent(input: AccountAccessIdentityInput): Promise<void>;
}

export function createAccountRequestAuthService(
  resolver: AccountRequestAuthResolver,
): IAccountRequestAuthService {
  return {
    resolveAccessCurrent(access) {
      return resolver.resolveAccessCurrent(access);
    },
    resolveCurrent(input) {
      return resolver.resolveCurrent(input);
    },
    assertCurrent(input) {
      return resolver.assertCurrent(input);
    },
  };
}

export type {
  AccountRequestAuthInput,
  AccountAccessIdentityInput,
  AccountRequestAuthMaterial,
  AccountRequestAuthResolver,
} from "./accountProviderRequestAuthService.js";
