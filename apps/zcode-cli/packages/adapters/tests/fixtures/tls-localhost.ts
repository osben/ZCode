import { generateKeyPair, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import forge from "node-forge";

const generateKeyPairAsync = promisify(generateKeyPair);

export async function generateTestTlsCertificate(): Promise<{ key: string; cert: string }> {
  const { privateKey, publicKey } = await generateKeyPairAsync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
  cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  cert.validity.notAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
  const attributes = [
    { name: "commonName", value: `zcode-test-${randomBytes(8).toString("hex")}` },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { key: privateKey, cert: forge.pki.certificateToPem(cert) };
}
