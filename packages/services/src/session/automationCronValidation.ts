import { Cron } from "croner";

/** Validate a cron expression (5 fields, local time zone). */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner parses the expression during construction and throws for invalid expressions.
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}
