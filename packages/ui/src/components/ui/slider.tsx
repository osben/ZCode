import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";

function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-surface relative h-1.5 w-full grow overflow-hidden rounded-full"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="bg-brand absolute h-full" />
      </SliderPrimitive.Track>
      {/* Single-thumb slider: the root's aria-label names the thumb, which owns the slider role. */}
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={ariaLabel}
        className="border-surface bg-primary-foreground ring-2 ring-brand/60 block size-4 shrink-0 rounded-full shadow-sm transition-[color,box-shadow] outline-none focus-visible:ring-4 focus-visible:ring-brand/30 disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
