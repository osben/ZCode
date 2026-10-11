const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';",
  "try{",
  "$zcodeSecurityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1');",
  "Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop;",
  "}catch{",
  "[Console]::Error.WriteLine(('Windows PowerShell Security module load failed: {0}' -f $_.Exception.Message));",
  "exit 26;",
  "};",
].join("");

function encodeUtf8Value(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function createEncodedPowerShellArgs(script, values = []) {
  // Windows PowerShell 5.1 joins arguments after a regular `-Command` back into command text instead
  // of passing them through `$args`. Encode dynamic values separately and pass them through
  // `-EncodedCommand`, which also prevents spaces in Program Files, quotes, or semicolons from being
  // reparsed as script content.
  const valueBindings = values
    .map(
      (value, index) =>
        `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8Value(value)}'));`,
    )
    .join("");
  const encodedCommand = Buffer.from(`${valueBindings}${script}`, "utf16le").toString("base64");
  return [...POWERSHELL_COMMON_ARGS, "-EncodedCommand", encodedCommand];
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // Node launched by pwsh inherits PowerShell 7's PSModulePath. When it later starts Windows
  // PowerShell 5.1, it may discover an incompatible Security module. Load system modules directly from
  // the current powershell.exe PSHOME instead of treating an external environment variable as a
  // trusted module root.
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}
