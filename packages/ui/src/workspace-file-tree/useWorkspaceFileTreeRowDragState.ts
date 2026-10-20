import { useEffect, useState } from "react";

export function useWorkspaceFileTreeRowDragState() {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      return;
    }

    // Electron/browsers do not always dispatch dragend to the source row when a drag leaves the window.
    // Also listen for the global end signal so the guide line is not left hidden after an interrupted drag.
    const resetDragging = () => setIsDragging(false);
    window.addEventListener("dragend", resetDragging);
    window.addEventListener("drop", resetDragging);
    window.addEventListener("blur", resetDragging);
    return () => {
      window.removeEventListener("dragend", resetDragging);
      window.removeEventListener("drop", resetDragging);
      window.removeEventListener("blur", resetDragging);
    };
  }, [isDragging]);

  return { isDragging, setIsDragging };
}
