import { z } from "zod";
import {
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  databaseStartupErrorDetailsSchema,
} from "@zcode/shared";

export const tasksStorageWorkerDataSchema = z
  .object({
    path: z.string().min(1),
    // Only the first local Host of an app process may send true; see specs/first-submission-lifecycle.md "Placeholder startup sweep".
    sweepAbandonedReservations: z.boolean().optional(),
  })
  .strict();
export const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
export type TasksStorageWorkerMessage = z.infer<typeof workerMessageSchema>;
