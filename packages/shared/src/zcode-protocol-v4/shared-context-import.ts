import { z } from "zod";

const sharedContextImportV2StateSchema = z
  .object({
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    shareUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            url.search === "" &&
            url.hash === "" &&
            /^\/cn\/share\/[^/]+$/u.test(url.pathname)
          );
        } catch {
          return false;
        }
      }, "shareUrl must use the canonical /cn/share/<code> path"),
    status: z.enum(["pending", "reserved", "attached", "discarded"]),
  })
  .strict();
// shareUrl is fixed to /cn/share/<code>. If the domain changes or the English site's /share/<code>
// becomes canonical, persisted provenance in existing sessions will fail validation. This is local
// persistence, not wire data, so the "tolerant response" rule does not apply. Before changing the
// canonical URL shape, add a legacy branch that accepts the old shape, following
// legacySharedContextImportStateSchema.

const legacySharedContextImportStateSchema = z.object({ title: z.string().trim().min(1) }).strict();

export const sharedContextImportStateSchema = z.union([
  sharedContextImportV2StateSchema,
  legacySharedContextImportStateSchema,
]);

export type SharedContextImportState = z.infer<typeof sharedContextImportStateSchema>;
