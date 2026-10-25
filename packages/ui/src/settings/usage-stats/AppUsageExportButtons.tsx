import { Download } from "lucide-react";
import { useState } from "react";
import type { AppUsageSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  buildUsageCsv,
  buildUsageJson,
  usageExportFileName,
} from "@/settings/usage-stats/appUsagePatternsViewModel.js";

const BLOB_URL_REVOKE_DELAY_MS = 10_000;

type ExportKind = "csv" | "json";
const MIME_TYPES: Record<ExportKind, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
};

function downloadWithBlob(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers start the download asynchronously; revoking right away can yield an empty file.
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
}

export function AppUsageExportButtons({
  snapshot,
  query,
}: {
  snapshot: AppUsageSnapshot;
  query: unknown;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const [busy, setBusy] = useState(false);

  const handleExport = async (kind: ExportKind) => {
    if (busy) return;
    setBusy(true);
    try {
      const text =
        kind === "csv"
          ? buildUsageCsv(snapshot, intl.formatMessage({ id: "settings.usage.unknownModel" }))
          : buildUsageJson(snapshot, query, new Date());
      const name = usageExportFileName(snapshot, kind);
      if (platform?.saveFile) {
        const data = new TextEncoder().encode(text).buffer as ArrayBuffer;
        const result = await platform.saveFile({ data, suggestedName: name });
        if (result.canceled) return;
        if (!result.success || !result.path) throw new Error(result.error ?? "save_failed");
        toast(intl.formatMessage({ id: "settings.usage.export.saved" }, { path: result.path }));
        return;
      }
      downloadWithBlob(name, MIME_TYPES[kind], text);
    } catch (error) {
      logger.error("[AppUsageExportButtons] export failed", error);
      toast(intl.formatMessage({ id: "settings.usage.export.failed" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(["csv", "json"] as const).map((kind) => (
        <Button
          key={kind}
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="h-8 rounded-md bg-background"
          onClick={() => void handleExport(kind)}
        >
          <Download className="size-3.5" />
          {intl.formatMessage({ id: `settings.usage.export.${kind}` })}
        </Button>
      ))}
    </>
  );
}
