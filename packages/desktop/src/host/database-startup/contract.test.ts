import { expect, it } from "vitest";
import { tasksStorageWorkerDataSchema, workerMessageSchema } from "./contract.js";
import { exampleWorkerData } from "./contract.example.js";
it("accepts the reservation sweep gate only as a boolean", () => {
  expect(
    tasksStorageWorkerDataSchema.parse({ path: "./db", sweepAbandonedReservations: true })
      .sweepAbandonedReservations,
  ).toBe(true);
  expect(
    tasksStorageWorkerDataSchema.safeParse({ path: "./db", sweepAbandonedReservations: "yes" })
      .success,
  ).toBe(false);
});

it("拒绝空路径和未约定输入，不接受缺少迁移阶段的进度", () => {
  expect(tasksStorageWorkerDataSchema.parse(exampleWorkerData)).toEqual(exampleWorkerData);
  expect(tasksStorageWorkerDataSchema.safeParse({ path: "" }).success).toBe(false);
  expect(tasksStorageWorkerDataSchema.safeParse({ path: "./db", hostId: "other" }).success).toBe(
    false,
  );
  expect(workerMessageSchema.safeParse({ type: "progress" }).success).toBe(false);
  expect(workerMessageSchema.parse({ type: "progress", phase: "maintaining" })).toEqual({
    type: "progress",
    phase: "maintaining",
  });
  expect(workerMessageSchema.parse({ type: "done" })).toEqual({ type: "done" });
});
