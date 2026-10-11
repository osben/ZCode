import { z } from "zod";

const orderList = z.array(z.string().trim().min(1)).transform((items) => [...new Set(items)]);
const modeOrderSchema = z.object({
  categoryOrder: orderList.optional(),
  pluginOrder: z.record(z.string(), orderList).optional(),
});
const pluginStoreOrderSchema = z.object({
  code: modeOrderSchema.optional().catch(undefined),
  work: modeOrderSchema.optional().catch(undefined),
});

export type PluginStoreModeOrder = z.infer<typeof modeOrderSchema>;
export type PluginStoreOrder = z.infer<typeof pluginStoreOrderSchema>;

/** Ordering is a display preference; invalid modes fall back independently and must not block catalog browsing or affect another mode. */
export function parsePluginStoreOrder(value: unknown): PluginStoreOrder | null {
  return pluginStoreOrderSchema.safeParse(value).data ?? null;
}
