/**
 * Build-time switch: when enabled, the installer uses the Preview identity, while the backend
 * environment remains controlled separately by `ZCODE_ENV`.
 * For example, `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1` creates a `ZCode Preview` that connects
 * to the production backend and can be installed alongside the regular release.
 */
export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "dev.zcode.app",
  productName: "ZCode",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
  cuaHelperInstallVariant: null,
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "dev.zcode.app.preview",
  productName: "ZCode Preview",
  linuxExecutableName: "zcode-preview",
  linuxPackageName: "zcode-preview",
  cuaHelperInstallVariant: "preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * The only enabled spelling is `1` (`0` or empty means disabled), matching the exact
 * `$ZCODE_PREVIEW_IDENTITY == "1"` comparison in CI workflow rules and release gates. Other spellings
 * fail during the build so values such as `true` cannot be missed by YAML routing but enabled by the
 * script, placing a Preview package in the production acceptance directory.
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * Product identity (flavor) and backend environment (`ZCODE_ENV`) are independent:
 * - `ZCODE_ENV=test` always uses the Preview identity so a test backend cannot overwrite a user's regular
 *   `ZCode` installation.
 * - `ZCODE_ENV=production` uses the regular identity by default and switches to Preview only when
 *   `ZCODE_PREVIEW_IDENTITY=1` is explicitly set.
 * Unknown `ZCODE_ENV` values continue to use test, matching the shared layer's fail-safe default in
 * normalizeZCodeEnv.
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * The artifact filename suffix identifies the backend environment, not the product identity: `_TEST`
 * appears only on packages for the test backend. A Preview package for the production backend is
 * distinguished from the regular package by productName (`ZCode Preview-<version>-...`).
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * Return the AppUserModelId used by Windows Shell.
 *
 * Packaged builds must reuse electron-builder's appId. Otherwise, Windows treats the AUMID in shortcuts,
 * the Start menu index, and the running Electron process as three different apps. Keep the existing
 * identity in development to prevent local debug shortcuts from interfering with regular or Preview
 * installations.
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "cn.aminer.zcode";
  }
  return desktopProductIdentities[flavor === "preview" ? "preview" : "production"].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
