import { z } from "zod";

// This schema is used by both the validation aggregate entry point and the legacy protocol, so it must live in a leaf module with no reverse dependencies.
// Root cause: protocol imports this from validation, while validation imports the protocol's resource-sampling schema,
// so ESM/Jiti in a clean Docker environment reads an uninitialized binding first, causing startup to crash at `.optional()`.
export const zcodeTaskModeSchema = z.enum([
  "default",
  "yolo",
  "guarded",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);
