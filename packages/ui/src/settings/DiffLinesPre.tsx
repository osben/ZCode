import { cn } from "@/components/lib/utils.js";
import type { DiffLine } from "@/settings/outputStylesEditorModel.js";

/** Line-by-line save preview shared by the output style and system prompt editors. */
export function DiffLinesPre({
  lines,
  "data-testid": testId,
}: {
  lines: readonly DiffLine[];
  "data-testid"?: string;
}) {
  return (
    <pre
      className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5"
      data-testid={testId}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            line.type === "add" && "text-success",
            line.type === "remove" && "text-danger line-through",
          )}
        >
          {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}
