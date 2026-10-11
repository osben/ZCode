import type { ZCodeProvider } from "@zcode/shared";
import { GlmMonochromeIcon } from "@/components/ui/GlmMonochromeIcon.js";

export function renderProviderCliIcon(_provider: ZCodeProvider = "glm", className?: string) {
  // Only the glm provider remains; preserve the original logo silhouette and apply grayscale only.
  // The previous outlined version was more purely monochrome but reduced brand recognition too much.
  // A shared filter keeps the original logo while making its colors more subdued.
  return <GlmMonochromeIcon className={className} />;
}
