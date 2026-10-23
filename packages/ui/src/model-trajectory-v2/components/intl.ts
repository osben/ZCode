import type { IntlInstance } from "@/i18n/IntlProvider.js";

export type TrajectoryIntl = Pick<IntlInstance, "formatMessage">;

export function tr(intl: TrajectoryIntl, id: string, values?: Record<string, string>): string {
  return intl.formatMessage({ id }, values);
}
