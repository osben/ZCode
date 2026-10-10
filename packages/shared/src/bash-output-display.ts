import { z } from "zod";

// Raw Bash files are never sent over the protocol; only a bounded header and the actual truncation/file-retention facts are passed through.
export const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();
