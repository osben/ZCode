# Built-in plugin icons

Built-in plugin store entries are defined in
`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`. Each
`listing.icon` uses the official plugin asset CDN:

```
https://cdn-zcode.z.ai/zcode/official-plugin/assets/<plugin-name>/icon.png
```

`computer-use` reuses the published `assets/zcode-cua/icon.png`. After the plugin id
changed from `zcode-cua` to `computer-use`, the CDN asset directory kept the original
name; the icon path must not be derived from the plugin id as the unpublished
`computer-use/icon.png` (it returns 404). Icon path and plugin id are maintained
independently.

Assets come from `assets/<plugin-name>/icon.png` in the `zcode-plugins` repository;
its `main` branch publish pipeline syncs the assets directory to the CDN. Icons use
HTTPS URLs to satisfy the client's trusted-image-address validation. PNGs must use a
transparent background and keep the original Figma colors; the store renders icons on
a semantic `bg-hover` container and does not invert whole images for dark themes,
which would distort Android, iOS, and ZCode brand colors. The Installed Strip must
not apply whole-avatar opacity based on plugin enabled state; enabled state is
expressed in the manage view. If an asset request fails or no icon is configured, the
store keeps showing the default icon.

The Installed Strip in Figma node `5080:5352` defines the visual contract: a 24px
glyph centered in a 36px rounded container. Built-in plugin definition order must
match icon order:

1. `android-emulator` → `android`
2. `document-skills` → `dotpoints-01`
3. `ios-simulator` → `ios`
4. `restore-legacy-sessions` → `Frame` (arrow-up archive box)
5. `skill-creator` → `Frame` (cube)
6. `zcode-guide` → ZCode logo

When sorting the Installed Strip, built-in/inline plugins always come before
marketplace-installed plugins and sort stably by display name in the current
language; marketplace-installed plugins keep descending install time. Sorting uses
the runtime `source`; never infer built-in identity indirectly from a missing
`installedAt`.

Current built-in plugins: `android-emulator`, `document-skills`, `ios-simulator`,
`restore-legacy-sessions`, `skill-creator`, `zcode-guide`.
