export const REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
  "node-pty",
  "glm",
  "bfs",
  "ripgrep",
  "ugrep",
] as const;

export type RemoteResourcePackageId = (typeof REMOTE_RESOURCE_PACKAGE_IDS)[number];

export const ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
  "node-pty",
  "glm",
  "bfs",
  "ripgrep",
  "ugrep",
] as const satisfies readonly RemoteResourcePackageId[];

export const REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
] as const satisfies readonly RemoteResourcePackageId[];

export const REMOTE_RESOURCE_PACKAGE_DEPENDENCIES: Partial<
  Record<RemoteResourcePackageId, readonly RemoteResourcePackageId[]>
> = {};

export const OPTIONAL_REMOTE_RESOURCE_PACKAGE_IDS = ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS.filter(
  (id) =>
    !REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS.includes(
      id as (typeof REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS)[number],
    ),
);

export interface RemoteResourcePackageSelection {
  selectedPackageIds?: string[];
}

const REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  REMOTE_RESOURCE_PACKAGE_IDS,
);

const ACTIVE_REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS,
);

const REQUIRED_REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS,
);

export function normalizeRemoteResourcePackageSelection(
  _selection?: RemoteResourcePackageSelection | null,
): RemoteResourcePackageId[] {
  // This branch keeps only one ZCode Agent; the legacy SSH resource-package selection no longer has product meaning.
  // Regardless of choices saved in legacy config, new versions deploy the full active resource set to avoid reusing stale filtering after reconnect.
  return [...ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS];
}

export function isActiveRemoteResourcePackage(packageId: RemoteResourcePackageId): boolean {
  return ACTIVE_REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId);
}

export function isKnownRemoteResourcePackageId(packageId: string): boolean {
  return REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId as RemoteResourcePackageId);
}

export function isRequiredRemoteResourcePackage(packageId: RemoteResourcePackageId): boolean {
  return REQUIRED_REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId);
}

export function getRemoteResourcePackageDependencies(
  packageId: RemoteResourcePackageId,
): readonly RemoteResourcePackageId[] {
  return REMOTE_RESOURCE_PACKAGE_DEPENDENCIES[packageId] ?? [];
}

export function isRemoteResourcePackageSelectedAsDependency(
  packageId: RemoteResourcePackageId,
  selectedPackageIds: readonly RemoteResourcePackageId[],
): boolean {
  const selectedPackages = new Set(selectedPackageIds);
  return selectedPackageIds.some((selectedPackageId) =>
    getRemoteResourcePackageDependencies(selectedPackageId).some(
      (dependencyId) => dependencyId === packageId && selectedPackages.has(dependencyId),
    ),
  );
}
