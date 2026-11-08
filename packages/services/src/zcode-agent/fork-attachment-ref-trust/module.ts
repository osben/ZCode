/**
 * fork-attachment-ref-trust module manifest (architecture-governance managed module).
 * Scope: Host admission of AttachmentRef.ref / previewRef by trusted connection origin.
 * Layer: app. When changing requires, update architecture-policy.yaml as well.
 */
export const forkAttachmentRefTrustModule = {
  id: "fork-attachment-ref-trust",
  requires: ["fork-attachment-ref-trust-shared"],
  provides: ["fork-attachment-ref-trust"],
  publicEntrypoints: ["contract.ts"],
} as const;
