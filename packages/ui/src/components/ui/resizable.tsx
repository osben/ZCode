// import { GripHorizontal, GripVertical } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type GroupProps,
  type Layout,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

export const WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME = cn(
  "aria-[orientation=vertical]:w-1 aria-[orientation=vertical]:translate-x-0 aria-[orientation=vertical]:my-0 aria-[orientation=vertical]:h-full",
  "hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent",
  "aria-[orientation=vertical]:[mask-image:none] aria-[orientation=vertical]:[-webkit-mask-image:none]",
  "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius,var(--radius-xl))] after:w-0.5",
  "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
);

/* ------------------------------------------------------------------ */
/*  ResizablePanelGroup                                                */
/* ------------------------------------------------------------------ */

/**
 * 布局百分比之和应为 100。组宽极窄的某一帧，多个 collapsible 面板可能被一起折叠成全 0；
 * 这种布局一旦持久化，库每次挂载都会原样恢复且无法自愈（文件面板黑屏），读写时都要丢弃。
 */
function isUsableLayout(layout: Layout | undefined): layout is Layout {
  if (!layout) return false;
  const sizes = Object.values(layout);
  if (sizes.length === 0 || !sizes.every(Number.isFinite)) return false;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 99 && total < 101;
}

/**
 * 带 localStorage 持久化的 PanelGroup 封装。
 * 传入 layoutId 即可自动保存/恢复布局；不传则不持久化。
 * panelIds 用于支持条件渲染的面板（面板数量会变化时必须传）。
 */
function ResizablePanelGroup({
  className,
  layoutId,
  panelIds,
  ...props
}: Omit<GroupProps, "defaultLayout" | "onLayoutChange" | "onLayoutChanged"> & {
  /** Persistence key, corresponding to useDefaultLayout's id. */
  layoutId: string;
  /** Pass the IDs of currently visible panels when panels are conditionally rendered. */
  panelIds?: string[];
}) {
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: layoutId,
    panelIds,
  });

  return (
    <Group
      className={cn("flex h-full w-full", className)}
      defaultLayout={isUsableLayout(defaultLayout) ? defaultLayout : undefined}
      // onLayoutChanged 会在每次布局变化后立刻写 localStorage。
      // 窗口 resize 时 PanelGroup 会连续产生成百上千次 layout 更新，必须走库内置
      // debounce 的 onLayoutChange，避免同步持久化放大主线程压力。
      onLayoutChange={(layout) => {
        if (isUsableLayout(layout)) onLayoutChange(layout);
      }}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ResizablePanel                                                     */
/* ------------------------------------------------------------------ */

const ResizablePanel = Panel;
type ResizablePanelProps = PanelProps;

/* ------------------------------------------------------------------ */
/*  ResizableHandle                                                    */
/* ------------------------------------------------------------------ */

function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      // react-resizable-panels' Separator does not expose data-orientation;
      // it outputs aria-orientation instead, with the orientation opposite to PanelGroup.
      // The previous data-[orientation=...] selector never matched, making w-px / h-px appear to have no effect.

      className={cn(
        "group/handle relative flex shrink-0 items-center justify-center bg-transparent outline-none transition-colors focus:outline-none focus-visible:outline-none focus-visible:bg-border-hover/60 focus-visible:ring-0",
        "hover:bg-border-hover/60 data-[separator=hover]:bg-border-hover/60 data-[separator=active]:bg-border-hover z-10",

        // react-resizable-panels actively focuses the current Separator on pointerdown;
        // if focus styling is not handled here, Chromium draws a default yellow highlight around the focusable role=separator.
        // The color returning after opening a terminal/browser is just focus moving elsewhere; the layout did not fix itself.
        "aria-[orientation=vertical]:translate-x-px",
        "aria-[orientation=vertical]:my-6",
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=vertical]:h-[calc(100%-48px)]",
        "aria-[orientation=vertical]:[mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=vertical]:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",

        "aria-[orientation=horizontal]:translate-y-px",
        "aria-[orientation=horizontal]:mx-6",
        "aria-[orientation=horizontal]:h-px",
        "aria-[orientation=horizontal]:w-[calc(100%-48px)]",
        "aria-[orientation=horizontal]:[mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=horizontal]:[-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",

        className,
      )}
      {...props}
    >
      {/* <div
        className="z-10 flex items-center justify-center rounded-sm
          text-on-surface-muted/40
          transition-colors
          group-data-[orientation=horizontal]/handle:h-6
          group-data-[orientation=horizontal]/handle:w-3
          group-data-[orientation=vertical]/handle:h-3
          group-data-[orientation=vertical]/handle:w-6"
      >
        <GripVertical
          size={12}
          className="group-data-[orientation=vertical]/handle:hidden"
        />
        <GripHorizontal
          size={12}
          className="hidden group-data-[orientation=vertical]/handle:block"
        /> 
      </div>*/}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, type ResizablePanelProps };
