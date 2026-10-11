import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";
import { getAppConfigDir } from "../paths.js";

// Self-signed CA for the app (separate from the debug traffic-inspection proxy, which is used only in debug builds).
// Generate a self-signed root CA on first startup. The agent subprocess trusts the public certificate through NODE_EXTRA_CA_CERTS;
// the egress proxy uses the private key to re-sign TLS. Reuse existing files as-is so the certificate fingerprint remains stable once trusted.

const APP_CA_CERT_FILE = "zcode-network-ca.pem";
const APP_CA_KEY_FILE = "zcode-network-ca.key";
const CA_VALIDITY_YEARS = 10;
const CA_KEY_BITS = 2048;

export interface AppCaCertPaths {
  certPath: string;
  keyPath: string;
}

export function getAppCaCertPaths(): AppCaCertPaths {
  const certDir = join(getAppConfigDir(), "certs");
  return {
    certPath: join(certDir, APP_CA_CERT_FILE),
    keyPath: join(certDir, APP_CA_KEY_FILE),
  };
}

/**
 * Ensure the app's self-signed CA exists, generating it if missing. Return the certificate (public key) path.
 * Idempotent: if both the certificate and private key exist, return without regenerating them.
 */
export function ensureAppCaCert(): string {
  const { certPath, keyPath } = getAppCaCertPaths();
  if (existsSync(certPath) && existsSync(keyPath)) {
    return certPath;
  }

  const { certPem, keyPem } = generateSelfSignedCa();
  mkdirSync(join(getAppConfigDir(), "certs"), { recursive: true });
  // The private key contains sensitive material, so restrict permissions to 0600; the public certificate can be read.
  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  return certPath;
}

function generateSelfSignedCa(): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(CA_KEY_BITS);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  // Use cryptographically secure random bytes for the serial number; clear the first byte to avoid parsing it as negative.
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  cert.serialNumber = serial.toString("hex");

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + CA_VALIDITY_YEARS);
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: "commonName", value: "ZCode Network CA" },
    { name: "organizationName", value: "ZCode" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // Self-signed: issuer == subject.
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", critical: true, keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
