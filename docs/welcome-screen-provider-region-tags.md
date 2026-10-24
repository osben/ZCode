# Welcome Screen Provider Region Tags

When signed out, the Welcome Screen's OAuth provider entries show both Z.AI and BigModel. To help users tell the
service regions of the two entries apart, a fixed region tag follows the button label:

- Z.AI: zh-CN `全球` (Global), English `Global`
- BigModel: zh-CN `中国` (China), English `CN`

The tag copy must go through `packages/ui/src/i18n/locales/*`, and the component keeps only the mapping from provider
id to message id. The tag only expresses the regional difference of the entry and takes no part in OAuth provider
selection, ordering, availability or provider family domain judgment. Size uses a compact pill: `h-5 px-2 text-ui-xs`.

OAuth provider buttons use `Button variant="default"`, with the background from `bg-primary`. In the ZAI theme the
background is `#000000` in light mode and `#ffffff` in dark mode, and text uses `text-primary-foreground`. The region
tag is secondary information inside the button and no longer uses the Coding Plan's standalone gradient badge; its
style follows the button foreground color, using `border-primary-foreground/30 text-primary-foreground/60`, so it is
only a weak emphasis in both light and dark themes.
