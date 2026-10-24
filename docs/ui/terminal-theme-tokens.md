# Terminal Theme Tokens

The xterm theme in `packages/ui/src/Terminal.tsx` reads terminal-specific tokens from
`packages/ui/src/styles.css`.

Tokens in use: `--color-terminal-bg`, `--color-terminal-fg`, `--color-terminal-cursor`,
`--color-terminal-cursor-accent`, `--color-terminal-selection`, `--color-terminal-selection-inactive`, the
eight ANSI colors `--color-terminal-{black,red,green,yellow,blue,magenta,cyan,white}` and their bright
variants `--color-terminal-bright-{black,red,green,yellow,blue,magenta,cyan,white}`.

How to adjust:

1. Edit the matching tokens in the light `@theme` and the dark `.dark` of `packages/ui/src/styles.css`.
2. `Terminal` re-reads the tokens on theme switch and updates the xterm colors live.

Design constraints:

- The Zai Light terminal background and cursor-accent must follow `--color-background`, so the terminal
  area does not hard-code pure white and detach from the workspace background. Default body text, ANSI
  colors and selection color are still tuned separately by terminal tokens to keep command output readable.
- The selection color prefers a low-opacity brand-color blend, avoiding being too heavy in both themes.
- The 16 ANSI colors map first onto the existing semantic color families and neutral ramp, without
  introducing scattered color values.
