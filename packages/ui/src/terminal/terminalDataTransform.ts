const ESC = String.fromCharCode(0x1b);
const SGR_SEQUENCE_PATTERN = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
const PSREADLINE_REDRAW_CURSOR_PATTERN = new RegExp(`${ESC}\\[\\d+;\\d+H`);
const PSREADLINE_DEFAULT_ON_BLACK_PATTERN = new RegExp(
  `${ESC}\\[(?:[0-9;]*;)?37(?:;[0-9;]*)?m[\\s\\S]*${ESC}\\[(?:[0-9;]*;)?40(?:;[0-9;]*)?m`,
);

function isPowerShellShell(shell: string | null): boolean {
  if (!shell) return false;
  const shellParts = shell.split(/[\\/]/);
  const lastPart = shellParts[shellParts.length - 1];
  const name = lastPart?.replace(/\.exe$/i, "").toLowerCase();
  return name === "powershell" || name === "pwsh";
}

function replaceAnsiBlackBackgroundWithDefault(data: string): string {
  return data.replace(SGR_SEQUENCE_PATTERN, (sequence, rawParams: string) => {
    const params = rawParams.length > 0 ? rawParams.split(";") : ["0"];
    let changed = false;
    const nextParams = params.map((param) => {
      if (param === "40") {
        changed = true;
        return "49";
      }
      return param;
    });
    return changed ? `${ESC}[${nextParams.join(";")}m` : sequence;
  });
}

export function normalizePowerShellReadlineRedraw(data: string, shell: string | null): string {
  if (!isPowerShellShell(shell)) return data;
  if (!data.includes(ESC) || data.includes("\n")) return data;
  if (!PSREADLINE_REDRAW_CURSOR_PATTERN.test(data)) return data;
  if (!PSREADLINE_DEFAULT_ON_BLACK_PATTERN.test(data)) return data;

  // When Windows PowerShell/PSReadLine redraws the current input line, it uses ANSI 40m to add a black background to trailing blank cells.
  // The z-code terminal background is not ANSI black, so xterm renders those cells as gray blocks; restore the default background only for this line-edit redraw.
  return replaceAnsiBlackBackgroundWithDefault(data);
}
