/**
 * Draft first-send interception intent for the empty-state "New worktree" checkbox
 * (review recommendation 6c; see
 * docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md).
 *
 * 机制：checkbox（draft empty state header 内）在激活时把拦截器写进 slot，
 * ConversationComposer 在首发（draft）前读取 slot 并调用拦截器；拦截器完成
 * worktree 创建与 draft 重定向（文本由既有 composer continuity 机制保留）。
 * slot 是稳定对象（useMemo 创建），值变化不触发消费者重渲染；表单状态仍留在
 * 组件/hook 内，不引入全局 store。
 */
import { createContext, useContext } from "react";

/**
 * 注册进 slot 的首发拦截意图。`workspaceKey` 用现有 identity 规则
 * （`workspaceIdentity?.trim() || workspacePath`）锁定来源 draft composer，
 * 防止 split pane / 其他 workspace 的 composer 误触。
 */
export interface ComposerDraftWorktreeIntent {
  workspaceKey: string;
  /**
   * 拦截首发：完成校验与 worktree 创建。返回 true 表示该次发送已被处理
   * （重定向或内联报错），composer 不得继续发送并保留草稿文本；
   * 返回 false 表示意图失效，按正常发送继续。
   */
  interceptFirstSend: () => Promise<boolean>;
}

/** 稳定的可变槽位：provider 创建一次，写入方（checkbox）与读取方（composer）共享。 */
export type ComposerDraftWorktreeIntentSlot = {
  current: ComposerDraftWorktreeIntent | null;
};

export function createComposerDraftWorktreeIntentSlot(): ComposerDraftWorktreeIntentSlot {
  return { current: null };
}

export const ComposerDraftWorktreeIntentContext = createContext<
  ComposerDraftWorktreeIntentSlot | undefined
>(undefined);

export function useComposerDraftWorktreeIntentSlot(): ComposerDraftWorktreeIntentSlot | undefined {
  return useContext(ComposerDraftWorktreeIntentContext);
}
