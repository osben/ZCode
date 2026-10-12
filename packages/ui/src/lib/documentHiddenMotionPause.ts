/**
 * Pauses CSS animations while the page is hidden; spec in
 * docs/performance/hidden-document-motion-pause.md.
 *
 * Bug root cause: when the window is hidden Chromium stops emitting animation frames, so CSS
 * transition/animation cannot settle. If an animated element is removed at that moment,
 * DocumentTimeline keeps a strong reference to it, and the parent pointer drags the entire
 * unmounted message subtree with it (measured: 230k DOM nodes after GC while hidden, falling back
 * to 45k within 1s of becoming visible). This marks <html> using document.visibilityState as the
 * single source of truth; styles.css disables animations based on that marker, guaranteeing no new
 * animation objects are created while hidden.
 */
export const DOCUMENT_HIDDEN_ATTRIBUTE = "data-document-hidden";

export function installDocumentHiddenMotionPause(doc: Document = document): () => void {
  const sync = () => {
    doc.documentElement.toggleAttribute(
      DOCUMENT_HIDDEN_ATTRIBUTE,
      doc.visibilityState === "hidden",
    );
  };
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => {
    doc.removeEventListener("visibilitychange", sync);
    doc.documentElement.removeAttribute(DOCUMENT_HIDDEN_ATTRIBUTE);
  };
}
