import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { logger } from "@/logger.js";

interface WebglRendererHandle {
  addon: WebglAddon | null;
  contextLossSubscription: IDisposable | null;
  /** 动态 import 进行中；期间再次开启不重复加载，开关关闭则放弃激活。 */
  activating: boolean;
  /** WebGL 启动失败或上下文丢失后置位，避免每次 effect 重试；关闭开关时整体清除。 */
  blocked: boolean;
}

const handles = new WeakMap<XTerm, WebglRendererHandle>();

function releaseAddon(handle: WebglRendererHandle): void {
  handle.contextLossSubscription?.dispose();
  handle.contextLossSubscription = null;
  const addon = handle.addon;
  handle.addon = null;
  if (!addon) return;
  try {
    // WebglAddon.dispose 会把渲染器切回 DOM 渲染器；重复调用由 xterm 包装的 dispose 幂等处理。
    addon.dispose();
  } catch (error) {
    logger.warn("[Terminal] dispose WebGL addon failed:", error);
  }
}

/**
 * 按开关切换单个 xterm 实例的渲染器：开启时尝试 WebGL，失败或上下文丢失时保持/回退到 DOM 渲染器。
 * 调用必须在 term.open 之后；重复调用是幂等的。
 *
 * @xterm/addon-webgl 按需动态加载：功能默认关闭，静态引入会让每个终端入口
 * （主窗口、side pane、remote）的 bundle 都携带并求值 WebGL 代码。
 */
export function setTerminalWebglRenderer(term: XTerm, enabled: boolean): void {
  const existing = handles.get(term);

  if (!enabled) {
    if (existing) {
      releaseAddon(existing);
      handles.delete(term);
    }
    return;
  }

  if (existing?.addon || existing?.activating || existing?.blocked) return;

  const handle: WebglRendererHandle = existing ?? {
    addon: null,
    contextLossSubscription: null,
    activating: false,
    blocked: false,
  };
  handles.set(term, handle);
  handle.activating = true;

  void import("@xterm/addon-webgl")
    .then(({ WebglAddon: WebglAddonCtor }) => {
      // 等待加载期间开关被关闭：句柄已从 WeakMap 移除，放弃激活，避免复活已关闭的渲染器。
      if (handles.get(term) !== handle) return;

      const addon = new WebglAddonCtor();
      try {
        term.loadAddon(addon);
      } catch (error) {
        // 不 dispose 的话，xterm loadAddon 已把 addon 登记到 _addons，
        // 后续 term.dispose 会对未激活的 addon 重复处理。WebGL2 不可用时 activate 会先注册渲染器 disposable 再抛错，
        // 所以这里必须主动 dispose，把登记和渲染器一起回收。
        try {
          addon.dispose();
        } catch {
          // 清理失败只影响本次 addon 残留，DOM 渲染器仍可用，不再向上抛出。
        }
        handle.blocked = true;
        logger.warn("[Terminal] WebGL renderer unavailable, falling back to DOM:", error);
        return;
      }

      handle.addon = addon;
      handle.contextLossSubscription = addon.onContextLoss(() => {
        logger.warn("[Terminal] WebGL context lost, falling back to DOM renderer");
        releaseAddon(handle);
        handle.blocked = true;
      });
    })
    .catch((error) => {
      logger.warn("[Terminal] WebGL renderer unavailable, falling back to DOM:", error);
      if (handles.get(term) === handle) handle.blocked = true;
    })
    .finally(() => {
      if (handles.get(term) === handle) handle.activating = false;
    });
}
