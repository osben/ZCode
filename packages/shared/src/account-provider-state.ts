import { z } from "zod";

// The reason is sent with Account State and must share the strict protocol enum to prevent rejection of the entire snapshot.
// credential-failed means credential retrieval or validation failed; it does not prove that OAuth is invalid.
export const accountProviderUnavailableReasonSchema = z.enum([
  "not-authenticated",
  "not-connected",
  "credential-failed",
  "not-entitled",
]);
export type AccountProviderUnavailableReason = z.infer<
  typeof accountProviderUnavailableReasonSchema
>;
