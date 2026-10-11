import { Suspense, lazy } from "react";
import type { PdfViewerLabels, PdfViewerSource } from "@/components/ui/pdf-viewer.js";

// react-pdf (including pdf.js and its worker) is large; lazy loading includes it in the bundle only when a PDF preview is first opened,
// so sessions that do not use PDFs do not start more slowly.
const PdfViewer = lazy(() =>
  import("@/components/ui/pdf-viewer.js").then((module) => ({
    default: module.PdfViewer,
  })),
);

interface PdfPreviewContentProps {
  source: PdfViewerSource;
  labels: PdfViewerLabels;
}

export function PdfPreviewContent({ source, labels }: PdfPreviewContentProps) {
  return (
    <Suspense
      fallback={<div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>}
    >
      <PdfViewer source={source} labels={labels} className="h-full" />
    </Suspense>
  );
}
