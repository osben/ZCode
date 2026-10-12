/**
 * Pure navigation state for the Command Center page stack (Copilot-style
 * pushPage/popPage/resetPages: selecting an item with a `page` pushes an
 * in-palette sub-page instead of closing the dialog).
 *
 * 保持为纯函数模块：CommandCenterDialog 只保存一个 stack 值，
 * 每次跳转（push/pop/reset）都返回新 stack 和应写入搜索框的 query，
 * 保证栈与每页搜索上下文在同一次状态更新中提交。
 */

export interface CommandCenterPageRef {
  id: string;
  /** i18n message id used as the search input placeholder while the page is active. */
  placeholderId: string;
  /** Id of the command that pushed this page; the dialog re-resolves page contents from it. */
  commandId: string;
}

export interface CommandCenterPageStack {
  /** Pushed sub-pages, deepest last; empty means the palette root. */
  pages: CommandCenterPageRef[];
  /** Remembered search text per page id; the root uses {@link COMMAND_CENTER_ROOT_PAGE_ID}. */
  queryByPageId: Record<string, string>;
}

export interface CommandCenterPageTransition {
  stack: CommandCenterPageStack;
  /** Search text the dialog should install after applying the transition. */
  query: string;
}

/** Synthetic page id under which the palette root's query is remembered. */
export const COMMAND_CENTER_ROOT_PAGE_ID = "__root__";

export function createCommandCenterPageStack(): CommandCenterPageStack {
  return { pages: [], queryByPageId: {} };
}

export function getActiveCommandCenterPage(
  stack: CommandCenterPageStack,
): CommandCenterPageRef | null {
  return stack.pages[stack.pages.length - 1] ?? null;
}

function getTopPageId(stack: CommandCenterPageStack): string {
  const page = getActiveCommandCenterPage(stack);
  return page ? page.id : COMMAND_CENTER_ROOT_PAGE_ID;
}

function rememberTopQuery(stack: CommandCenterPageStack, query: string): CommandCenterPageStack {
  return {
    ...stack,
    queryByPageId: { ...stack.queryByPageId, [getTopPageId(stack)]: query },
  };
}

/**
 * Push a sub-page: remember the current query under the current top (root or page),
 * then restore the pushed page's remembered query (empty on first visit).
 */
export function pushCommandCenterPage(
  stack: CommandCenterPageStack,
  page: CommandCenterPageRef,
  query: string,
): CommandCenterPageTransition {
  const remembered = rememberTopQuery(stack, query);
  return {
    stack: { ...remembered, pages: [...remembered.pages, page] },
    query: remembered.queryByPageId[page.id] ?? "",
  };
}

/**
 * Pop the deepest page: remember its query, then restore the previous top's
 * (or the root's) remembered query. Popping an empty stack is a no-op.
 */
export function popCommandCenterPage(
  stack: CommandCenterPageStack,
  query: string,
): CommandCenterPageTransition {
  if (stack.pages.length === 0) {
    return { stack, query };
  }

  const remembered = rememberTopQuery(stack, query);
  const pages = remembered.pages.slice(0, -1);
  const previousTopId = pages[pages.length - 1]?.id ?? COMMAND_CENTER_ROOT_PAGE_ID;
  return {
    stack: { ...remembered, pages },
    query: remembered.queryByPageId[previousTopId] ?? "",
  };
}

/**
 * Clear the stack back to the root (after applying a value-list selection) while
 * keeping per-page query memory, and restore the root's remembered query.
 */
export function resetCommandCenterPageStack(
  stack: CommandCenterPageStack,
  query: string,
): CommandCenterPageTransition {
  const remembered = rememberTopQuery(stack, query);
  return {
    stack: { pages: [], queryByPageId: remembered.queryByPageId },
    query: remembered.queryByPageId[COMMAND_CENTER_ROOT_PAGE_ID] ?? "",
  };
}
