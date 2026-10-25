import type { ServiceLocale } from "./locale.js";

export type FeedbackTicketType = "bug" | "usage" | "feature" | "performance";

export type FeedbackTicketStatus =
  | "已提交"
  | "信息不足"
  | "已采纳"
  | "答复关闭"
  | "已归档"
  | "已拒绝"
  | "开发中"
  | "已解决"
  | "已上线";

export type FeedbackAttachmentKind = "log" | "image" | "other";

export type FeedbackTicketModule =
  | "Plugin / MCP"
  | "Agent任务执行失败"
  | "模型配置 / API Key"
  | "模型调用报错"
  | "权限 / 配置保存"
  | "SSH连接失败"
  | "WSL连接失败"
  | "UI布局 / 交互"
  | "模型响应慢 / 额度"
  | "崩溃 / Internal Error"
  | "文档 / 使用咨询"
  | "其它";

export type FeedbackTicketFramework = "zcode-agent";

/**
 * The UI Select does not allow an empty string as an option value (Radix throws an error),
 * so use a sentinel for "unspecified" here; it is converted to undefined before submitting the ticket.
 */
export const FEEDBACK_FRAMEWORK_NONE = "none" as const;
export type FeedbackTicketFrameworkSelectValue =
  | FeedbackTicketFramework
  | typeof FEEDBACK_FRAMEWORK_NONE;

export type FeedbackTicketSeverity = "P1-高" | "P2-中" | "P3-低";

export interface FeedbackReporter {
  user_id?: string;
  username?: string;
  display_name?: string;
}

export interface FeedbackDeviceInfo {
  appVersion?: string;
  buildCommitId?: string;
  buildTime?: string;
  electronVersion?: string;
  nodeVersion?: string;
  osType?: string;
  osPlatform?: string;
  osRelease?: string;
  osVersion?: string;
  osArch?: string;
  /** Current Agent when submitting feedback. Fixed to ZCode Agent in single-agent mode. */
  agentProvider?: string;
  /** Framework identifier normalized for the feedback platform; currently fixed to zcode-agent. */
  agentFramework?: FeedbackTicketFramework;
  /** Raw selected value from the current model configuration when submitting feedback. */
  agentModel?: string;
  /** Display name matched from the model list when submitting feedback; falls back to agentModel when unavailable. */
  agentModelDisplay?: string;
  /** Number of available options in the current model list when submitting feedback. */
  agentModelOptionCount?: number;
  /** Preview of display names in the current model list when submitting feedback, for troubleshooting configuration context. */
  agentModelOptionsPreview?: string[];
  hostname?: string;
  deviceMid?: string;
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  framework?: FeedbackTicketFramework;
  source?: string;
  reporter?: FeedbackReporter;
  device?: FeedbackDeviceInfo;
  /** Optional contact information from the user (email or another social account); not required by the backend. */
  contact?: string;
  /** Current UI language; forwarded only in the request header and not written into the ticket body on the backend. */
  locale?: ServiceLocale;
}

export interface FeedbackTicketSummary {
  id: string;
  title: string;
  type: FeedbackTicketType;
  severity?: FeedbackTicketSeverity;
  module?: FeedbackTicketModule;
  status: FeedbackTicketStatus;
  assignee_id?: string | null;
  /** Display name of the current assignee (filled by the backend); null when unassigned. */
  assignee_display?: string | null;
  /** Reporter display name returned by the backend. */
  reporter_display?: string | null;
  /** Whether there has been a new action since the last view. */
  unread?: boolean;
  /** Time of the most recent user action. */
  last_user_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type FeedbackTicketEventType =
  | "created"
  | "status_changed"
  | "assignee_changed"
  | "staff_replied"
  | "user_replied";

export interface FeedbackTicketEvent {
  id: number;
  type: FeedbackTicketEventType;
  summary: string;
  actor_display_name?: string | null;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export interface FeedbackAttachment {
  id: number;
  kind: FeedbackAttachmentKind;
  filename: string;
  size: number;
  sha256?: string | null;
  redacted: boolean;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at: string;
}

export interface FeedbackCommentAttachment {
  id: number;
  filename: string;
  size: number;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
}

export interface FeedbackComment {
  id: number;
  /** Backend message_id, used to keep attaching files to the message after the follow-up message is created. */
  message_id?: string;
  author_user_id?: string | null;
  author_display_name?: string | null;
  body: string;
  attachments?: FeedbackCommentAttachment[];
  is_staff: boolean;
  created_at: string;
}

export interface FeedbackTicketDetail extends FeedbackTicketSummary {
  description: string;
  framework?: FeedbackTicketFramework;
  reporter?: FeedbackReporter | null;
  device?: FeedbackDeviceInfo | null;
  attachments: FeedbackAttachment[];
  comments: FeedbackComment[];
  events: FeedbackTicketEvent[];
  lark_record_id?: string | null;
}

export interface FeedbackListQuery {
  mine?: boolean;
  status?: FeedbackTicketStatus;
  type?: FeedbackTicketType;
  offset?: number;
  limit?: number;
}

export interface FeedbackListResult {
  items: FeedbackTicketSummary[];
  total: number;
}

export const FEEDBACK_TICKET_MODULES: FeedbackTicketModule[] = [
  "Plugin / MCP",
  "Agent任务执行失败",
  "模型配置 / API Key",
  "模型调用报错",
  "权限 / 配置保存",
  "SSH连接失败",
  "WSL连接失败",
  "UI布局 / 交互",
  "模型响应慢 / 额度",
  "崩溃 / Internal Error",
  "文档 / 使用咨询",
  "其它",
];

export const FEEDBACK_TICKET_TYPES: { value: FeedbackTicketType; label: string }[] = [
  { value: "bug", label: "Bug 反馈" },
  { value: "usage", label: "使用问题" },
  { value: "feature", label: "功能建议" },
  { value: "performance", label: "性能问题" },
];

export const FEEDBACK_TICKET_SEVERITIES: FeedbackTicketSeverity[] = ["P1-高", "P2-中", "P3-低"];

export const DEFAULT_FEEDBACK_TICKET_FRAMEWORK: FeedbackTicketFramework = "zcode-agent";

export const FEEDBACK_TICKET_FRAMEWORK_OPTIONS: {
  value: FeedbackTicketFramework;
  label: string;
}[] = [{ value: "zcode-agent", label: "ZCode Agent" }];

/** Full list including "unspecified," for admin and similar use cases. */
export const FEEDBACK_TICKET_FRAMEWORKS: {
  value: FeedbackTicketFrameworkSelectValue;
  label: string;
}[] = [{ value: FEEDBACK_FRAMEWORK_NONE, label: "未指定" }, ...FEEDBACK_TICKET_FRAMEWORK_OPTIONS];
