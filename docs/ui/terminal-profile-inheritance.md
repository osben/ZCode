# Terminal Profile Inheritance

The goal of ZCode's built-in terminal is not to maintain a fixed font list but to inherit as much as possible
of the profile already in effect in the user's system terminal, so with oh-my-zsh, oh-my-posh, Nerd Font,
kubectl proxy and custom Kube config the built-in terminal is closer to opening the system terminal directly.

## Current Coverage

- Runtime environment: at service start, PATH, proxy, KUBECONFIG, locale and common toolchain variables are
  captured from the login shell and merged into the later ZCode Agent/terminal child process environment.
- Font: at terminal creation the font resolves in the order "explicit user override > system terminal config
  > ZCode fallback font stack". System terminal config currently covers Windows Terminal, VS Code, iTerm2,
  > macOS Terminal, Kitty and Alacritty.
- Colors: terminal background, default text color and cursor color are always controlled by the current ZCode
  app theme; a system terminal profile may only add terminal detail colors such as the ANSI palette and
  selection. So inheriting an iTerm2 / Terminal profile on macOS does not bring a dark background into a light
  ZCode UI, nor make the cursor invisible by clashing with the current background, while the user's familiar
  command output colors are kept.
- Settings: General settings has an "Inherit system terminal profile" switch and a "Terminal font" override
  input; with the font empty it returns to automatic inheritance.

## Main Modules

- `packages/services/src/runtime-tools/runtimeCommandEnv.ts`: login shell environment inheritance.
- `packages/services/src/terminal/terminalProfile.ts`: terminal font profile detection, extended through a
  detector registry for different terminal sources.
- `packages/services/src/terminal/terminalService.ts`: returns the resolved font profile when creating the PTY.
- `packages/ui/src/terminal/TerminalSession.tsx`: applies the font and the restricted profile theme returned
  by the server to xterm.

## Extension

To add WezTerm or another terminal source, add a `TerminalFontDetector` in `terminalProfile.ts`, implement
`detect(env)` and register it in `TERMINAL_FONT_DETECTORS`; the main flow needs no change.

iTerm2 and macOS Terminal are best-effort detectors: they only try to read local plists, and on read failure,
bad format or a missing field return `null` and the next detector is tried, without affecting terminal
startup. The macOS profile detector may read `background` / `foreground` / `cursor` / `cursorAccent`, but the
UI merge stage discards them: these fields are the basic-readability boundary of the ZCode window theme and
must not be overridden by a system terminal profile, otherwise a dark terminal block may appear in a light app,
or the cursor may vanish by clashing with the current terminal background, which would also be inconsistent
with Windows currently inheriting only the font.
