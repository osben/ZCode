# Unified lucide Stroke Width in packages/ui

`packages/ui` imports icons directly from `lucide-react` and unifies the default stroke width at the app
root with the official `LucideProvider`. Current default: `DEFAULT_LUCIDE_STROKE_WIDTH = 1.5`.

Conventions:

- `packages/ui/src/Root.tsx` injects the default through `LucideProvider`, keeping line thickness
  consistent across the whole UI.
- An individual icon with a special visual need may still pass `strokeWidth` explicitly to override it.
- New icons are imported directly from `lucide-react`; no in-project icon forwarding wrapper is maintained.
- User-customized window icons live in `components/icons/windowIcons.ts`, created with the official
  `createLucideIcon`, inheriting `currentColor` and the global stroke width; the maximize/restore shapes
  keep the supplied SVG paths and include no white backing plate.
- Window icons use a 24x24 viewBox with the shape inside coordinates 5-19; the restore icon's front layer
  is a 10x10 rounded rectangle starting at `(5, 9)`. Button size does not change with the shape path.
