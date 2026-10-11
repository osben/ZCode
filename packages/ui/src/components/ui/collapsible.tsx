import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        "group/collapsible-content overflow-hidden",
        "data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:[animation-fill-mode:forwards] transition-none duration-300 ease-in-out",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "transition-none duration-300 ease-in-out",
          "group-data-[state=open]/collapsible-content:animate-in group-data-[state=open]/collapsible-content:fade-in-0",
          "group-data-[state=closed]/collapsible-content:animate-out group-data-[state=closed]/collapsible-content:fade-out-0 group-data-[state=closed]/collapsible-content:[animation-fill-mode:forwards]",
        )}
      >
        {/* Large-session resize traces show that when the collapsible animation layer sets only duration/ease,
            the browser uses the default transition-property: all to animate scrollbar-color, causing non-composited animation while resizing the window.
            Explicitly disable CSS transitions here and keep only the animate-in/out keyframe animations. */}
        {/* tw-animate-css does not provide utilities such as animate-fade-in / animate-fade-out;
            use animate-in/out with fade-in-0 / fade-out-0 instead.
            The child div itself has no data-state, so continue reading the parent content state here
            to keep opacity and height animations on separate layers.
            Add a slight delay on open so the fade-in is not consumed while the content is still clipped to zero height. */}
        {children}
      </div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
