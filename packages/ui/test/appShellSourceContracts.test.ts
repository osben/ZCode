import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let appSource = "";
let taskNavigationSource = "";

beforeAll(async () => {
  // 同一套源码契约共享不可变 fixture，避免重复读取 App 和 task 导航源码。
  [appSource, taskNavigationSource] = await Promise.all([
    readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app-shell/useWorkspaceTaskNavigation.ts", import.meta.url), "utf8"),
  ]);
});

function getQuickPickCommandsMemoBlock(source: string): string {
  const start = source.indexOf("const quickPickCommands = useMemo");
  const end = source.indexOf("  );", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectNoTaskQueryCacheHookSubscription(source: string) {
  // 性能回归保护：task meta 高频刷新只应在命令触发时通过 getState 读取快照，
  // 不应让 App 或导航 hook 订阅整个 task query cache 后带动 shell 重渲染。
  expect(source).not.toMatch(/\buseTaskQueryCacheStore\s*\(/);
}

describe("App quick pick command render stability", () => {
  it("does not recreate quick pick commands when only the user object reference changes", () => {
    const memoBlock = getQuickPickCommandsMemoBlock(appSource);

    // 性能回归保护：commands 会一路传给 CommandCenterDialog。
    // 这里只需要登录态布尔值，不应订阅完整 user 对象引用。
    expect(memoBlock).toContain("isLoggedIn");
    expect(memoBlock).not.toMatch(/\n\s+user,\n/);
  });

  it("memoizes task find dialog props before passing them to the shell layout", () => {
    // 性能回归保护：taskFindDialogProps 是对象 prop，内联创建会让 WorkspaceShellLayout
    // 在无关流式刷新中看到新引用并继续向下重渲染。
    expect(appSource).toContain("const taskFindDialogProps = useMemo<TaskFindDialogProps>");
    expect(appSource).toContain("taskFindDialogProps={taskFindDialogProps}");
  });
});

describe("task query cache render subscription boundary", () => {
  it("keeps App from subscribing to the whole task query cache", () => {
    expectNoTaskQueryCacheHookSubscription(appSource);
  });

  it("keeps task navigation handlers from subscribing to the whole task query cache", () => {
    expectNoTaskQueryCacheHookSubscription(taskNavigationSource);
    expect(taskNavigationSource).toContain("setTaskQueryCacheUnreadOverlay");
    expect(taskNavigationSource).toContain("reconcileTaskQueryCacheUnread");
    expect(taskNavigationSource).not.toContain("setTaskUnreadIndicator");
    expect(taskNavigationSource).not.toContain("targetWorkspaceState.taskListCache");
  });

  it("选择已有 task 时保留 workspace slash command 目录", () => {
    // Bug 原因：目录属于 workspace identity；task 导航若主动清空，session projection
    // 不会替 composer 回填，已知 session 的自定义 slash command 会永久消失。
    expect(taskNavigationSource).not.toMatch(/\.setSlashCommands\s*\(/);
    expect(taskNavigationSource).not.toMatch(/const\s+setSlashCommands\s*=\s*useZCodeSessionStore/);
  });
});
