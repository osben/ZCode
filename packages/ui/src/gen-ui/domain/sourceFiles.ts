import { projectGenUiReferences } from "@/gen-ui/domain/references.js";

export function collectGenUiSourcePaths(text: string): readonly string[] {
  // Only complete references are recognized here, for deduplication; no pages are mounted.
  // Execution timing and file authorization remain the responsibility of the existing Gen UI pipeline.
  return [
    ...new Set(
      projectGenUiReferences(text, true).flatMap((part) =>
        part.kind === "ui" ? [part.reference.path] : [],
      ),
    ),
  ];
}

export function matchesGenUiSourcePath(path: string, sources: readonly string[]): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");
  const candidate = normalize(path);
  return sources.some((source) => normalize(source) === candidate);
}
