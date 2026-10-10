import type { DragEventHandler } from "react";

/**
 * File-drop interface exposed by ConversationComposer to the outer conversation surface.
 *
 * The controller routes to the existing composer within the renderer; it creates no second upload state machine
 * and does not change the desktop-continuous / web-remote-replayable transport boundary.
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | null;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}
