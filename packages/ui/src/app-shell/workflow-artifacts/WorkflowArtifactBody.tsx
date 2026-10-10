import { lazy, Suspense, useMemo } from "react";
import type { FileBinaryPreview } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  isArtifactPresetKind,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { ArtifactPresetBody } from "@/app-shell/workflow-artifacts/ArtifactPresetBody.js";
import {
  ArtifactMetadataCard,
  ArtifactNotice,
  WorkflowArtifactHtmlCard,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactCards.js";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { usePdfViewerLabels, usePptxViewerLabels } from "@/hooks/usePreviewViewerLabels.js";
import type { Theme } from "@/useTheme.js";

/**
 * Body of the `workflow-artifact` tab.
 *
 * ⚠ Terminology: artifact = output published to the user by a script through `artifact.*`.
 *
 * **No new rendering dependencies**: pdf / image / markdown / office / text use existing leaf viewers; preset dashboards use
 * the four 4b renderers. Dispatch is based on `contentType` in the journal record—it is computed by the driver from the extension table,
 * can be overridden by `opts.contentType`, and is the only type authority in this path (the store re-sniffs it on readback,
 * and that value is intentionally ignored).
 *
 * **No iframe by design**: the renderer has no CSP, and the `allow-scripts allow-same-origin` sandbox combination
 * is equivalent to escaping the sandbox. HTML therefore uses the existing browser tab (see `WorkflowArtifactHtmlCard`).
 */

// All three heavyweight viewers are lazy-loaded: pdf.js / docx-preview / xlsx wasm are each several hundred KB,
// while most sessions never open an artifact tab. The existing previewPane* wrappers already include Suspense.
const PdfPreviewContent = lazy(() =>
  import("@/previewPanePdfContent.js").then((module) => ({ default: module.PdfPreviewContent })),
);
const PptxPreviewContent = lazy(() =>
  import("@/previewPanePptxContent.js").then((module) => ({ default: module.PptxPreviewContent })),
);
const PreviewPaneOfficeContent = lazy(() =>
  import("@/previewPaneOfficeContent.js").then((module) => ({
    default: module.PreviewPaneOfficeContent,
  })),
);

const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Text types: render the body in a monospace code viewer. `text/markdown` is excluded; it uses MessageResponse. */
function textLanguageFor(contentType: string): string | undefined {
  if (contentType === "application/json") return "json";
  if (contentType === "text/csv") return "csv";
  if (contentType === "text/plain") return "text";
  if (contentType.startsWith("text/")) return "text";
  return undefined;
}

interface WorkflowArtifactBodyProps {
  artifact: WorkflowRunArtifactView;
  /** Version currently being viewed; content artifact bytes are read for this version. */
  version: number;
  bytes: Uint8Array<ArrayBuffer> | null;
  blob: Blob | null;
  objectUrl: string | null;
  /** Byte-read state: this component renders loading and error states (each viewer’s own loading state covers parsing only). */
  loading: boolean;
  error: string | null;
  /** Item stream for preset dashboards; always empty for content artifacts. */
  items: readonly ArtifactItem[];
  theme: Theme;
  resolvedTheme: "light" | "dark";
  /** “Open in browser” action for HTML; when absent, show only a hint. */
  onOpenBrowserUrl?: (url: string) => void;
  /** Absolute path on the local file system (present only for desktop-local when `sourcePath` is available). */
  localSourcePath?: string;
  /** “Show in workspace”: reveal a file tree with a bound path; without it, cards with no renderer do not show this button. */
  onReveal?: () => void;
  /** Whether this is the latest version—the original workspace file for an older version has already been overwritten, so HTML preview is available only for the latest version. */
  isLatestVersion: boolean;
  /** Metadata (including preset dashboard spec) is still loading; use it to distinguish “not here yet” from “does not exist.” */
  metadataLoading: boolean;
}

export function WorkflowArtifactBody(props: WorkflowArtifactBodyProps) {
  const { intl } = useZCodeIntl();
  const { artifact } = props;

  // Preset dashboards do not read bytes; render them directly.
  if (isArtifactPresetKind(artifact.kind)) {
    const labels = buildPresetLabels((descriptor, values) =>
      intl.formatMessage(descriptor, values),
    );
    return (
      <div className="h-full min-h-0 overflow-auto p-4" data-artifact-body="preset">
        <ArtifactPresetBody
          artifact={artifact}
          items={props.items}
          labels={labels}
          invalidLabel={intl.formatMessage({
            id: "chat.toolCall.workflow.run.artifacts.presetInvalid",
          })}
          // The spec is available only from the journal query, so **before metadata finishes loading** do not say “unavailable”—
          // otherwise every dashboard briefly flashes an error message when opened.
          {...(props.metadataLoading
            ? {}
            : {
                missingLabel: intl.formatMessage({
                  id: "chat.toolCall.workflow.run.artifacts.unavailable",
                }),
              })}
        />
      </div>
    );
  }

  if (props.error !== null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-error"
        tone="error"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
        detail={props.error}
      />
    );
  }
  if (props.loading || props.bytes === null) {
    return (
      <ArtifactNotice
        testId="workflow-artifact-loading"
        text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loading" })}
      />
    );
  }

  return <WorkflowArtifactContent {...props} bytes={props.bytes} />;
}

/**
 * Dispatch after bytes are ready. This is a separate component because of hooks: markdown decoding and office base64
 * conversion both use `useMemo`, and those hooks cannot be skipped on the frame where bytes are not ready (the hook count must remain constant).
 */
function WorkflowArtifactContent({
  artifact,
  bytes,
  blob,
  objectUrl,
  theme,
  resolvedTheme,
  onOpenBrowserUrl,
  onReveal,
  localSourcePath,
  isLatestVersion,
}: WorkflowArtifactBodyProps & { bytes: Uint8Array<ArrayBuffer> }) {
  const { intl } = useZCodeIntl();
  const pdfLabels = usePdfViewerLabels();
  const pptxLabels = usePptxViewerLabels();
  const contentType = artifact.contentType ?? "application/octet-stream";

  // Decode the three text states (markdown / code / HTML source) once. TextDecoder is always available in the renderer.
  const text = useMemo(() => {
    if (
      contentType !== "text/markdown" &&
      contentType !== "text/html" &&
      textLanguageFor(contentType) === undefined
    ) {
      return undefined;
    }
    return new TextDecoder().decode(bytes);
  }, [bytes, contentType]);

  // The office viewer accepts only `FileBinaryPreview.dataBase64`, so encode the bytes back to base64 once here.
  // Do this only for actual office files—do not compute 20 MiB of base64 unnecessarily for a PDF.
  const officePreview = useMemo<FileBinaryPreview | null>(() => {
    if (contentType !== DOCX_CONTENT_TYPE && contentType !== XLSX_CONTENT_TYPE) return null;
    return {
      path: artifact.sourcePath ?? artifact.id,
      dataBase64: encodeBytesToBase64(bytes),
      totalBytes: bytes.length,
    };
  }, [artifact.id, artifact.sourcePath, bytes, contentType]);

  // The PPTX viewer accepts an ArrayBuffer. `slice` creates an independent buffer because a Uint8Array buffer may have an offset.
  const pptxBuffer = useMemo(
    () =>
      contentType === PPTX_CONTENT_TYPE
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : null,
    [bytes, contentType],
  );

  if (contentType === "text/markdown") {
    return (
      // **Pass the theme** to markdown: a previous fix addressed dark text on a dark background (the renderer selects code-block colors by theme).
      <div className="h-full min-h-0 overflow-y-auto px-4 py-4" data-artifact-body="markdown">
        <MessageResponse
          className="mx-auto w-full min-w-0 max-w-4xl break-words text-foreground"
          theme={theme}
        >
          {text ?? ""}
        </MessageResponse>
      </div>
    );
  }

  if (contentType === "application/pdf") {
    return (
      <div className="h-full min-h-0" data-artifact-body="pdf">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          {/* PdfViewerSource accepts a Blob; no need to write a file or use range transport. */}
          <PdfPreviewContent labels={pdfLabels} source={blob ?? new Blob([bytes])} />
        </Suspense>
      </div>
    );
  }

  if (contentType.startsWith("image/")) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background-alt p-4"
        data-artifact-body="image"
      >
        {objectUrl === null ? (
          <ArtifactNotice
            text={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.loadError" })}
            tone="error"
          />
        ) : (
          <img
            alt={artifact.title ?? artifact.id}
            className="max-h-full max-w-full object-contain"
            data-testid="workflow-artifact-image"
            src={objectUrl}
          />
        )}
      </div>
    );
  }

  if (contentType === PPTX_CONTENT_TYPE && pptxBuffer !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="pptx">
        <Suspense fallback={<ArtifactNotice text={pptxLabels.loading} />}>
          <PptxPreviewContent
            data={pptxBuffer}
            fileName={artifact.sourcePath ?? artifact.id}
            labels={pptxLabels}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (officePreview !== null) {
    return (
      <div className="h-full min-h-0" data-artifact-body="office">
        <Suspense fallback={<ArtifactNotice text={pdfLabels.loading} />}>
          <PreviewPaneOfficeContent
            error={null}
            kind={contentType === XLSX_CONTENT_TYPE ? "excel" : "docx"}
            loading={false}
            preview={officePreview}
            resolvedTheme={resolvedTheme}
            sourcePath={artifact.sourcePath ?? artifact.id}
            {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          />
        </Suspense>
      </div>
    );
  }

  if (contentType === "text/html") {
    return (
      <WorkflowArtifactHtmlCard
        artifact={artifact}
        bytes={bytes.length}
        isLatestVersion={isLatestVersion}
        {...(localSourcePath === undefined ? {} : { localSourcePath })}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onReveal === undefined ? {} : { onReveal })}
      />
    );
  }

  const language = textLanguageFor(contentType);
  if (language !== undefined && text !== undefined) {
    return (
      <div className="h-full min-h-0 overflow-auto" data-artifact-body="text">
        <CodeBlock appTheme={theme} code={text} language={language} showLineNumbers />
      </div>
    );
  }

  // Types outside the table (`application/octet-stream` and everything unrecognized): show a **metadata card**
  // without pretending they can be rendered. The card includes “Show in workspace,” the only available action for this artifact (there is no “Download”:
  // the renderer has no host capability to save these bytes as a user file).
  return (
    <ArtifactMetadataCard
      artifact={artifact}
      bytes={bytes.length}
      note={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.unsupported" })}
      testId="workflow-artifact-unsupported"
      {...(onReveal === undefined
        ? {}
        : {
            action: {
              label: intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" }),
              onActivate: onReveal,
              testId: "workflow-artifact-unsupported-reveal",
            },
          })}
    />
  );
}
