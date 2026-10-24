# File Display Utility

`packages/ui/src/lib/fileDisplay.tsx` formats a file path into a uniform display fragment.

Default behavior:

- Shows a file icon
- Shows only the main file name

Optional capabilities:

- Passing `basePath` outputs the relative directory as secondary text
- `showIcon` / `showFilePath` control whether the icon and path are shown
- `FileDisplayInline` reuses it directly in React components
- `createFileDisplayDom` reuses it in Lexical / native DOM scenarios

Example:

```ts
resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src/Avatar.ts", {
  basePath: "/Users/dev/Projects/element-web",
});
```

Output semantics:

- file-icon: `typescript`
- file-name: `Avatar.ts`
- file-path: `apps/web/src/`

`PromptMentionNode` uses this utility and shows "icon + file name" by default.

## Office file icons

- `.doc` and `.docx` map to `word.svg`, `.xlsx` to `table.svg`, and `.pptx` to `powerpoint.svg`.
- Office extensions and asset file names are not one-to-one; the mapping must be maintained through `EXTENSION_ICON_ALIASES`, and the resource path must not be built directly from the extension.
- Extensions without a matching asset must also be aliased: `.text` maps to `document.svg` because the icon set ships no `text.svg`, and the raw-extension fallback would otherwise request a missing asset (observed as a 404 in the packaged app).
- Desktop and Web must each carry the same icon files in `public/material-icons`, so local `file://`, plain Web and mobile `/remote` can all load them through the existing `BASE_URL` rule.
- The icon only expresses file type and does not change the preview, editing or remote-workspace capability boundary of Office files.
