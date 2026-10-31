import childProcess from "node:child_process";

const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  // The first module import writes progress CLIXML to stderr; silence progress only — real errors must still reject the update.
  "$ProgressPreference='SilentlyContinue';",
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

export async function readWindowsAuthenticodeSignature(filePath) {
  const script = [
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);",
    "$signature=Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
    "@{status=[int]$signature.Status;subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress;",
  ].join("");
  const stdout = await new Promise((resolve, reject) => {
    childProcess.execFile(
      "powershell.exe",
      createWindowsPowerShellSecurityArgs(script, [filePath]),
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
      (error, output, stderr) => {
        if (error || stderr) reject(error ?? new Error(stderr));
        else resolve(output);
      },
    );
  });
  return JSON.parse(stdout.replace(/^\uFEFF/u, "").trim());
}

export async function verifyWindowsAuthenticodeSignature(filePath) {
  const signature = await readWindowsAuthenticodeSignature(filePath);
  // Release authorization is decided by the official HTTPS manifest and file hashes; this only checks Windows signature validity.
  // The certificate DN is not pinned, so clients long-unupgraded after a cert rotation are not left dependent on a transitional build.
  if (
    signature.status !== 0 ||
    typeof signature.subject !== "string" ||
    !signature.subject.trim()
  ) {
    return "Windows update requires a valid Authenticode signature";
  }
  return null;
}
