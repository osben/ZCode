import {
  createLegacyCredentialCipher,
  type CredentialCipher,
} from "@zcode/shared/credential-security";
export type CredentialCipherProvider = CredentialCipher;
/** The legacy format is only for historical imports or explicit fixtures; the default service uses system secure storage. */
export function createCredentialCipherProvider(options: { env?: NodeJS.ProcessEnv } = {}) {
  return createLegacyCredentialCipher(options.env);
}
