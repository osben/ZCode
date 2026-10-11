import { z } from "zod";

/** Agent modes the Composer can submit explicitly; auto is an internal Runtime state and is not part of user Submission. */
export const submissionModeSchema = z.enum(["build", "edit", "plan", "yolo", "guarded"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
