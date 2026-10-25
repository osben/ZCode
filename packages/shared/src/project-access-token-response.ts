import { z } from "zod";

/** Success envelope codes shared by BigModel/Z.AI management and PAT issuance; does not relax token content validation. */
export const projectTokenSuccessCodeSchema = z.union([
  z.literal(200),
  z.literal(0),
  z.literal("200"),
  z.literal("0"),
]);
