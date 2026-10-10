import { z } from "zod";

/**
 * Single source of truth for ZCode agent providers.
 *
 * Both the ZCodeProvider type and runtime schema zcodeProviderSchema are derived here,
 * preventing inline z.enum([...]) copies from drifting as providers are added or removed.
 * This module depends only on zod (a leaf), so validation / zcode-protocol and others can import it without cycles.
 */
const ZCODE_PROVIDERS = ["glm"] as const;

export const zcodeProviderSchema = z.enum(ZCODE_PROVIDERS);

export type ZCodeProvider = (typeof ZCODE_PROVIDERS)[number];
