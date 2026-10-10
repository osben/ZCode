import { cn } from "@/components/lib/utils.js";
import zaiLogoUrl from "@/assets/provider-icons/logo-zai.svg";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // The workspace tool group on the left starts after the 1px panel border, while the old Settings title layer started at the window origin,
        // and the workspace logo sits inside a 28px button with another 4px of centering space from its left edge;
        // Settings renders a 20px image directly, so the button container’s left 13px cannot be used as the image coordinate.
        // After accounting for the 4px outer padding, 1px border, and 4px inside the button, the image is at left 17px / top 19px in both places.
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      <img
        src={zaiLogoUrl}
        alt="ZCode"
        className={cn("pointer-events-none size-5 select-none", imageClassName)}
        draggable={false}
      />
    </div>
  );
}
