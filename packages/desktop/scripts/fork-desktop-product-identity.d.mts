// Fork: declarations for fork-desktop-product-identity.mjs (the repo does not enable allowJs).
import type { DesktopProductFlavor, DesktopProductIdentity } from "./desktop-product-identity.mjs";

export type ForkProductVariant = "rs";
export type ForkDefaultAgentRuntime = "node" | "rust";

export interface ForkDesktopProductIdentity extends Omit<
  DesktopProductIdentity,
  "cuaHelperInstallVariant"
> {
  readonly forkVariant: ForkProductVariant | null;
  readonly cuaHelperInstallVariant: "preview" | "preview-rs" | null;
  readonly defaultAgentRuntime: ForkDefaultAgentRuntime;
}

export const ZCODE_FORK_RS_IDENTITY_ENV: "ZCODE_FORK_RS_IDENTITY";
export const FORK_PREVIEW_RS_IDENTITY: Readonly<
  ForkDesktopProductIdentity & {
    flavor: "preview";
    forkVariant: "rs";
    cuaHelperInstallVariant: "preview-rs";
    defaultAgentRuntime: "rust";
  }
>;
export function isForkRsIdentityRequested(env?: Record<string, string | undefined>): boolean;
export function resolveForkDesktopProductIdentity(
  env?: Record<string, string | undefined>,
): ForkDesktopProductIdentity;
export function resolveForkProductVariantDefine(
  env?: Record<string, string | undefined>,
): ForkProductVariant | "";
export function resolveForkWindowsAppUserModelId(
  flavor: DesktopProductFlavor,
  forkVariant: ForkProductVariant | null,
  runtime?: { isPackaged: boolean },
): string;
