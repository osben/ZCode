import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE, type SkillSyncSizeLimitErrorData } from "@zcode/shared";

// Raw errors carry only concatenated byte-count text, so after RPC the UI cannot reliably distinguish export, archive, and extraction failures.
// Pass through a stable code and structured data so the UI can show actionable errors in the current language.
export interface SkillSyncSizeLimitError extends Error {
  code: typeof SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  data: SkillSyncSizeLimitErrorData;
}

export function createSkillSyncSizeLimitError(
  data: SkillSyncSizeLimitErrorData,
): SkillSyncSizeLimitError {
  const error = new Error(
    `skill sync size limit exceeded: ${data.actualBytes}/${data.maxBytes} (${data.phase})`,
  ) as SkillSyncSizeLimitError;
  error.name = "SkillSyncSizeLimitError";
  error.code = SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  error.data = data;
  return error;
}
