interface TaskWorkbenchDragPreviewParams {
  clientX: number;
  clientY: number;
  dataTransfer: Pick<DataTransfer, "setDragImage">;
  source: HTMLElement;
}

function createTaskWorkbenchDragPreview({
  clientX,
  clientY,
  dataTransfer,
  source,
}: TaskWorkbenchDragPreviewParams): () => void {
  const document = source.ownerDocument;
  const sourceRect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.dataset.taskWorkbenchDragPreview = "true";
  // The default drag preview has a transparent background, leaving Project tasks without boundaries in the overlay.
  // Preserve the row content and add only the surface styling already used by the grouped drag overlay.
  preview.classList.add("border", "border-border", "bg-background", "shadow-lg");
  preview.style.position = "fixed";
  preview.style.left = "-10000px";
  preview.style.top = "-10000px";
  preview.style.pointerEvents = "none";
  preview.style.width = `${sourceRect.width}px`;
  document.body.append(preview);

  dataTransfer.setDragImage(
    preview,
    Math.max(0, Math.min(clientX - sourceRect.left, sourceRect.width)),
    Math.max(0, Math.min(clientY - sourceRect.top, sourceRect.height)),
  );

  return () => preview.remove();
}

export { createTaskWorkbenchDragPreview };
