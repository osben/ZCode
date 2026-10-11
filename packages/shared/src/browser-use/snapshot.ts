import { z } from "zod";

export const browserElementRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type BrowserElementRect = z.infer<typeof browserElementRectSchema>;

/**
 * Snapshot entry for one interactive element, providing role, name, and ref for targeting without dumping the entire page DOM.
 * ref is a stable reference assigned in DOM order (e1, e2, ...); subsequent actions use it to locate the element.
 */
export const browserSnapshotElementSchema = z
  .object({
    ref: z.string().min(1),
    tag: z.string(),
    role: z.string().optional(),
    /** accessibleName */
    name: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    disabled: z.boolean().optional(),
    checked: z.boolean().optional(),
    selector: z.string(),
    xpath: z.string(),
    rect: browserElementRectSchema,
    inViewport: z.boolean(),
    /** ref of the parent interactive element (hierarchy hint; omitted for top-level elements or when there is no interactive parent). */
    parentRef: z.string().optional(),
    /** Frame path for the element (marked when traversing same-origin iframes, e.g. "0>2"; omitted for the main document). */
    framePath: z.string().optional(),
    /** Bounded stable attributes used to build locators from DOM facts; noisy fields such as class/style/src are omitted. */
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotElement = z.infer<typeof browserSnapshotElementSchema>;

/**
 * Visible semantic DOM node. It is only for understanding the page; actionable handles remain in elements/ref
 * so body nodes do not consume the action-ref budget. ref is present only when this semantic node is also in elements.
 */
export const browserSnapshotDomNodeSchema = z
  .object({
    tag: z.string(),
    depth: z.number().int().nonnegative(),
    inViewport: z.boolean(),
    ref: z.string().min(1).optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type BrowserSnapshotDomNode = z.infer<typeof browserSnapshotDomNodeSchema>;

export const browserSnapshotSchema = z
  .object({
    url: z.string(),
    title: z.string(),
    /**
     * Bounded visible semantic DOM; optional to preserve protocol compatibility with older backends/results.
     * Must be defined before elements: Zod rebuilds objects in schema order, so when a large tool result is truncated,
     * the model should see page semantics before action details such as selector/xpath/rect.
     */
    dom: z.array(browserSnapshotDomNodeSchema).optional(),
    /** True when semantic DOM nodes exceed the internal budget. */
    domTruncated: z.boolean().optional(),
    elements: z.array(browserSnapshotElementSchema),
    /** Truncated when the number of elements exceeds maxElements. */
    truncated: z.boolean(),
  })
  .strict();
export type BrowserSnapshot = z.infer<typeof browserSnapshotSchema>;
