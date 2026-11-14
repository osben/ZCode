import childProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Single-quoted PowerShell literal: doubles straight and smart single quotes, which PowerShell treats alike. */
export function escapePowerShellLiteral(value) {
  if (["\0", "\r", "\n"].some((character) => value.includes(character))) {
    throw new Error("PowerShell path literal cannot contain NUL or newline characters");
  }
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // Node launched by pwsh inherits PowerShell 7's PSModulePath. When it later starts Windows
  // PowerShell 5.1, it may discover an incompatible Security module. Load system modules directly from
  // the current powershell.exe PSHOME instead of treating an external environment variable as a
  // trusted module root.
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}

export async function readWindowsAuthenticodeSignature(filePath) {
  const filePathLiteral = escapePowerShellLiteral(filePath);
  // The JSON goes through a private file, not stdout: console encoding and stray host output no longer
  // decide whether the signature result parses.
  const outputDir = await mkdtemp(join(tmpdir(), "zcode-signature-"));
  try {
    const outputPath = join(outputDir, "signature.json");
    const script = [
      `$zcodeArg0=${filePathLiteral};`,
      `$zcodeSignatureOutput=${escapePowerShellLiteral(outputPath)};`,
      "$ProgressPreference='SilentlyContinue';",
      "$ErrorActionPreference='Stop';",
      "try{",
      "$securityModule=Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1';",
      "Import-Module -Name $securityModule -Force -ErrorAction Stop;",
      "$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $zcodeArg0;",
      "@{status=[int]$signature.Status;subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress|Out-File -LiteralPath $zcodeSignatureOutput -Encoding utf8 -NoNewline;",
      "}catch{Write-Error ('Windows Authenticode query failed: ' + $_.Exception.Message) -ErrorAction Continue;exit 27};",
    ].join("");
    await new Promise((resolve, reject) => {
      childProcess.execFile(
        "powershell.exe",
        createEncodedPowerShellArgs(script),
        { encoding: "utf8", timeout: 30_000, windowsHide: true },
        (error, _output, stderr) => {
          if (error) reject(error);
          else if (stderr) reject(new Error(stderr));
          else resolve();
        },
      );
    });
    const text = await readFile(outputPath, "utf8");
    return JSON.parse(text.replace(/^\uFEFF/u, "").trim());
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
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
