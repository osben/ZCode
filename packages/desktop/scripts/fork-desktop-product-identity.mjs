/**
 * Fork: ZCode Preview RS identity (specs/fork-preview-rs-identity.md).
 *
 * Wraps the upstream identity resolver so `desktop-product-identity.mjs` stays upstream-identical.
 * The RS app keeps the `preview` flavor (all flavor checks behave as in ZCode Preview) and changes only
 * what must differ to install side by side, plus its default agent runtime.
 */
import {
  resolveDesktopProductIdentity,
  resolveWindowsAppUserModelIdForFlavor,
} from "./desktop-product-identity.mjs";

export const ZCODE_FORK_RS_IDENTITY_ENV = "ZCODE_FORK_RS_IDENTITY";

export const FORK_PREVIEW_RS_IDENTITY = Object.freeze({
  flavor: "preview",
  forkVariant: "rs",
  appId: "dev.zcode.app.preview.rs",
  productName: "ZCode Preview RS",
  linuxExecutableName: "zcode-preview-rs",
  linuxPackageName: "zcode-preview-rs",
  cuaHelperInstallVariant: "preview-rs",
  defaultAgentRuntime: "rust",
});

/** Same strict spelling as ZCODE_PREVIEW_IDENTITY: only `1` enables, `0` or empty disables. */
export function isForkRsIdentityRequested(env = process.env) {
  const value = env[ZCODE_FORK_RS_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_FORK_RS_IDENTITY_ENV}=${env[ZCODE_FORK_RS_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

export function resolveForkDesktopProductIdentity(env = process.env) {
  const base = resolveDesktopProductIdentity(env);
  if (!isForkRsIdentityRequested(env)) {
    return Object.freeze({ ...base, forkVariant: null, defaultAgentRuntime: "node" });
  }
  // An RS package must never take over the regular ZCode identity.
  if (base.flavor !== "preview") {
    throw new Error(
      `${ZCODE_FORK_RS_IDENTITY_ENV}=1 requires the Preview identity (ZCODE_PREVIEW_IDENTITY=1 or ZCODE_ENV=test)`,
    );
  }
  return FORK_PREVIEW_RS_IDENTITY;
}

/** Compile-time define value for `__ZCODE_FORK_PRODUCT_VARIANT__`: "rs" or "". */
export function resolveForkProductVariantDefine(env = process.env) {
  return resolveForkDesktopProductIdentity(env).forkVariant ?? "";
}

export function resolveForkWindowsAppUserModelId(
  flavor,
  forkVariant,
  runtime = { isPackaged: true },
) {
  if (forkVariant === "rs" && runtime.isPackaged !== false) {
    return FORK_PREVIEW_RS_IDENTITY.appId;
  }
  return resolveWindowsAppUserModelIdForFlavor(flavor, runtime);
}
