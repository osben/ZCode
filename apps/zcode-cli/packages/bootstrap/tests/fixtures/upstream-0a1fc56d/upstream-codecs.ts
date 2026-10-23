// Verbatim copies of the upstream ZCode decoding logic at the pin in fork-upstream-base.json
// (commit 0a1fc56d279fd1001f78387bd81aec1c26767411, v3.16.1). Do not edit these bodies by hand. The
// upstream build runs this logic when it reads the rows the fork writes into the shared ~/.zcode databases.
//
// Pin source map (paths relative to the repository root):
//   - modelSelectionSchema:            packages/shared/src/model-selection.ts:3-15
//   - parseModelSelectionValue:        apps/zcode-cli/packages/contracts/src/model/model.ts:60-64
//   - SESSION_TASK_TYPES, SESSION_TITLE_SOURCES: apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts:34-46
//   - decodeSessionTaskType, decodeSessionTitleSource: apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts:39-49
//   - decodeStoredMessage, isRecord:   codecs.ts:92-115
//   - decodeStoredPart, decodeTimelineSelection, decodeStoredSessionModelSelection: codecs.ts:126-158, 177-182
// Only edits: `export` added so the compatibility tests can call the functions, and the pin's `@zcode/contracts`
// type imports replaced by local aliases. Function bodies are unchanged.
import { z } from "zod";

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** 校验当前 ModelSelection 值；旧数据库格式只在版本化 migration 转换，不在普通读取时兜底。 */
export function parseModelSelectionValue(value: unknown): ModelSelection | undefined {
  const parsed = modelSelectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export function decodeSessionTaskType(value: string | null | undefined): SessionTaskType {
  return SESSION_TASK_TYPES.includes(value as SessionTaskType)
    ? (value as SessionTaskType)
    : "interactive";
}

export function decodeSessionTitleSource(value: string | null | undefined): SessionTitleSource {
  return SESSION_TITLE_SOURCES.includes(value as SessionTitleSource)
    ? (value as SessionTitleSource)
    : "first_input";
}

export function decodeStoredMessage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.role === "user") {
    const { model: _legacyModel, modelSelection: rawSelection, ...message } = value;
    // 迁移无法确定身份时可能留下 null；回滚后也可能缺字段。不能让配置残缺阻断整条消息的协议读取。
    // 这里只校验新结构，不查执行资格、不回读旧快照，磁盘内容保持不变。
    const modelSelection = parseModelSelectionValue(rawSelection);
    return { ...message, ...(modelSelection ? { modelSelection } : {}) };
  }
  if (value.role === "assistant") {
    const {
      providerID: _legacyProviderId,
      modelID: _legacyModelId,
      variant: _legacyReasoningLevel,
      ...message
    } = value;
    return message;
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeStoredPart(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (value.type === "timeline" && value.timelineType === "model_change") {
    const {
      fromModel: _oldFrom,
      toModel: _oldTo,
      fromModelSelection,
      toModelSelection,
      ...part
    } = value;
    const fromModel = decodeTimelineSelection(fromModelSelection);
    const toModel = decodeTimelineSelection(toModelSelection);
    return {
      ...part,
      ...(fromModel ? { fromModel } : {}),
      ...(toModel ? { toModel } : {}),
    };
  }
  if (value.type === "subtask") {
    const { model: _oldModel, modelSelection, ...part } = value;
    const model = parseModelSelectionValue(modelSelection);
    return { ...part, ...(model ? { model } : {}) };
  }
  return value;
}

export function decodeTimelineSelection(value: unknown) {
  if (!isRecord(value)) return undefined;
  // label 仅是 Timeline 展示信息，不属于严格的 Selection；不能误删合法的带标签历史。
  const { label, ...rawSelection } = value;
  const selection = parseModelSelectionValue(rawSelection);
  return selection ? { ...selection, ...(typeof label === "string" ? { label } : {}) } : undefined;
}

export function decodeStoredSessionModelSelection(value: unknown): unknown {
  // 旧平铺字段只属于升级入口。新成员即使为空/非法也不能借旧快照补值。
  // 解包在存储边界完成，core/bootstrap/fork 只消费 port 的当前逻辑 Selection。
  if (!isRecord(value)) return undefined;
  return parseModelSelectionValue(value.modelSelection) ?? value.modelSelection;
}
