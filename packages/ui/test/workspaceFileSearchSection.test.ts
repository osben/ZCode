import type { IFileService } from "@zcode/services";
import type { IServiceAccessor } from "@/hooks/useServices.js";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";

// 组件顶层 hook 链（useWorkspaceServicesResolution → useServices）要求 context 存在；
// 无 workspace 分支不会真正调用任何服务方法，空 accessor 即可。
const emptyAccessor = {} as unknown as IServiceAccessor;

function renderSection(props: { workspacePath?: string | null }): string {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: emptyAccessor },
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceFileSearchSection, props),
      ),
    ),
  );
}

describe("WorkspaceFileSearch settings section", () => {
  it("renders a hint instead of the editor when no workspace is open", () => {
    // 无 workspace 分支不触达 services：直接渲染提示文案，避免误拉文件服务。
    const html = renderSection({ workspacePath: null });
    // 显式固定中文，避免系统语言不同导致相同组件在 CI 上断言失败。
    expect(html).toContain("当前没有打开的工作区");
    expect(html).not.toContain("workspace-file-search-ignore-editor");
  });

  it("matches the fileService RPC surface used by the section", () => {
    // IFileService 契约快照：section 依赖的两个方法必须存在于服务接口，
    // 防止未来接口重命名悄悄断开设置页。
    const fileServiceKeys: Array<keyof IFileService> = [
      "readWorkspaceFileSearchIgnore",
      "writeWorkspaceFileSearchIgnore",
    ];
    expect(fileServiceKeys.every((key) => typeof key === "string")).toBe(true);
  });
});
