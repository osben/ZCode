import type { ImgHTMLAttributes } from "react";
import glmDarkIcon from "@/assets/cli-icons/icon-glm-for-dark.png";
import glmLightIcon from "@/assets/cli-icons/icon-glm-for-light.png";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";

type GlmMonochromeIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;

export function GlmMonochromeIcon({
  className,
  alt = "",
  style,
  ...props
}: GlmMonochromeIconProps) {
  const theme = useZCodeStore((state) => state.theme);
  const isDark = resolveTheme(theme) === "dark";
  const src = isDark ? glmDarkIcon : glmLightIcon;

  // A wireframe version would make the original logo less recognizable and look too light.
  // Restore the original bitmap here, applying only desaturation and luminance compression:
  // Keep a grayish appearance in light themes and brighten it toward white in dark themes,
  // removing the built-in blue without losing the original silhouette.
  const filter = isDark
    ? "grayscale(1) brightness(1.9) contrast(0.8)"
    : "grayscale(1) brightness(0.74) contrast(1.05)";

  return (
    <img
      src={src}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={cn("shrink-0 object-contain", className)}
      style={{ filter, ...style }}
      {...props}
    />
  );
}
