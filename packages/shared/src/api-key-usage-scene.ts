/** Creation usage scene of a key; independent of keyType, excludes the 3 and -1 sentinels kept only for legacy mappings/caches. */
export const API_KEY_USAGE_SCENE = {
  CODING_PLAN: 1,
  STANDARD: 2,
} as const;

export type ApiKeyCreationUsageScene =
  (typeof API_KEY_USAGE_SCENE)[keyof typeof API_KEY_USAGE_SCENE];
