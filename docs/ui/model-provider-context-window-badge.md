# Model Provider Context Window Badge

The model list on the model provider settings page shows the context window capacity inline at the right
of the model ID input.

## Display Rules

- Compact token capacity format: English like `128K`, `200K`, `1M`, `1.5M`; Chinese like `12.8万`, `20万`,
  `100万`, `150万`. The format is localized by locale (English `K` / `M` / `B`, Chinese `万` / `亿`).
- A model with the `[1m]` suffix keeps the runtime rule of forcing a 1,000,000 context window; the display
  unit still follows the locale.
- The full meaning is exposed as an accessible label `上下文窗口：{value}` / `Context window: {value}`.

## Layout Rules

- The capacity pill stays inside the model ID input, adding no list column width.
- The input reserves fixed space on its right; a long model ID still shrinks within the input itself.
- Uses semantic tokens `bg-surface`, `border-border`, `text-foreground-subtle`, compatible with light and
  dark themes.
