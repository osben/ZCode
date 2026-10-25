import { z } from "zod";
import {
  conversationShareContentBlockSchema,
  SHARE_CONTENT_LIMITS,
} from "./conversation-share-content.js";

import type { Locale } from "./protocol.js";
import {
  conversationArtifactTypeSchema,
  conversationRowSchema,
  type ConversationRow,
} from "./zcode-protocol-v4/rows.js";

/**
 * Share-site paths are locale-specific: the Chinese site uses the /cn prefix, while the English site
 * uses /share without a prefix. Web routing, published-link rewriting, and imported-link handling share
 * this definition instead of duplicating the prefix in three places.
 */
const CONVERSATION_SHARE_LOCALE_PATH_PREFIX: Readonly<Record<Locale, string>> = {
  "zh-CN": "/cn",
  "en-US": "",
  // The share site supports Chinese and English only; Ukrainian uses the English site.
  "uk-UA": "",
};

const CONVERSATION_SHARE_PATHNAME_RE = /^\/(cn\/)?share\/([^/]+)\/?$/u;

/**
 * Parse a share-page pathname and return the undecoded code segment and the locale for that path.
 * Recognize only `/share/<code>` and `/cn/share/<code>`; callers handle code decoding and validation.
 */
export function parseConversationSharePathname(
  pathname: string,
): { rawCode: string; locale: Locale } | null {
  const match = CONVERSATION_SHARE_PATHNAME_RE.exec(pathname);
  if (!match) return null;
  return { rawCode: match[2]!, locale: match[1] ? "zh-CN" : "en-US" };
}

/**
 * Rewrite a share link for the target locale's site.
 *
 * Rewrite only when the pathname exactly matches a known share shape, and replace only the locale
 * prefix without touching the code segment (avoiding changes from a decode/encode round trip). Return
 * every other shape unchanged. If the server later adopts a different URL shape or a separate domain,
 * this function will leave it alone rather than rewriting it incorrectly.
 */
export function localizeConversationShareUrl(shareUrl: string, locale: Locale): string {
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return shareUrl;
  }
  const parsed = parseConversationSharePathname(url.pathname);
  if (!parsed) return shareUrl;
  url.pathname = `${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale]}/share/${parsed.rawCode}`;
  return url.toString();
}

export const conversationShareAccessModeSchema = z.enum([
  "private",
  "public_readonly",
  "public_importable",
]);
export type ConversationShareAccessMode = z.infer<typeof conversationShareAccessModeSchema>;

/**
 * Share-payload version produced and understood by this client.
 *
 * Bump only for a breaking change in row semantics that cannot be skipped. New row kinds and enum
 * values do not count; decodeConversationShareRows handles those row by row. A bump makes all older
 * clients and deployed landing-page mirrors unable to read new shares, so check the installed-version
 * distribution before bumping.
 */
export const CONVERSATION_SHARE_SCHEMA_VERSION = 1;

/**
 * Accept inbound schema_version as a number first, then check it with
 * isConversationShareSchemaVersionSupported. Using z.literal would group "version too new" with
 * "response shape invalid" under the same invalid_contract error, so the user would see "invalid share
 * format" instead of "please upgrade ZCode."
 */
const conversationShareSchemaVersionSchema = z.number().int().positive();

/** Do not guess semantics for a version newer than this client supports; callers must report an upgrade request instead of a generic contract error. */
export function isConversationShareSchemaVersionSupported(version: number): boolean {
  return version <= CONVERSATION_SHARE_SCHEMA_VERSION;
}

/**
 * Decode public-projection rows individually, skipping and counting rows this client does not recognize.
 *
 * The transport layer intentionally does not interpret row semantics (rows are unknown[] on the wire),
 * so one row with a new kind, enum value, or timelineMarker type cannot make the entire share unreadable.
 * One mechanism handles all three cases, so enums do not need .catch(fallback): guessing enum semantics
 * incorrectly is more dangerous than dropping a row.
 *
 * The rendering pipeline is already tolerant: buildConversationTurnRenderUnits groups unknown kinds
 * under assistantWork, and ConversationShareReadonlyTimeline skips unknown values in its switch. This
 * decoder only needs to avoid throwing. Callers turn the count into a soft warning that some content
 * requires an updated ZCode; do not omit it silently.
 */
export function decodeConversationShareRows(rows: readonly unknown[]): {
  rows: ConversationRow[];
  unsupportedCount: number;
  unsupportedKinds: string[];
} {
  const decoded: ConversationRow[] = [];
  const unsupportedKinds: string[] = [];
  let unsupportedCount = 0;
  for (const row of rows) {
    const parsed = conversationRowSchema.safeParse(row);
    if (parsed.success) {
      decoded.push(parsed.data);
      continue;
    }
    unsupportedCount += 1;
    const kind = (row as { kind?: unknown } | null)?.kind;
    const label = typeof kind === "string" && kind.trim() ? kind.trim() : "unknown";
    if (!unsupportedKinds.includes(label)) unsupportedKinds.push(label);
  }
  return { rows: decoded, unsupportedCount, unsupportedKinds };
}

export const conversationShareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const conversationShareArtifactDescriptorFields = {
  artifact_id: z.string().trim().min(1),
  logical_artifact_key: z.string().trim().min(1),
  producer_product_turn_id: z.string().trim().min(1),
  artifact_version: z.number().int().positive(),
  state: z.literal("current"),
  ref: z.string().regex(/^zcode-artifact:\/\/share\/[A-Za-z0-9._~-]+$/u),
  artifact_type: conversationArtifactTypeSchema,
  display_name: z.string().trim().min(1),
  original_path: z.string().min(1).optional(),
  extension: z.string().trim().min(1),
  mime_type: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
} as const;

/**
 * Outbound descriptor (upload / confirm): strict, to catch our own bugs.
 *
 * The general rule for this contract is strict outbound and tolerant inbound: an extra field in our
 * request is our bug; an extra field in the server response is allowed.
 */
export const conversationShareArtifactDescriptorSchema = z
  .object(conversationShareArtifactDescriptorFields)
  .strict();
export type ConversationShareArtifactDescriptor = z.infer<
  typeof conversationShareArtifactDescriptorSchema
>;

/** Inbound descriptor (preview / continuation response): allows the server to add fields. */
export const conversationShareInboundArtifactDescriptorSchema = z.object(
  conversationShareArtifactDescriptorFields,
);

const conversationShareAllowedArtifactShapeSchema = z.object({
  // Intentionally do not use an artifact-type enum: capabilities is the server's capability-discovery
  // list, and a new artifact type must not invalidate the whole response and block every publish,
  // including publishes without artifacts. Discard unknown types while narrowing; this client cannot
  // produce them, so they cannot participate in any allow check.
  type: z.string().trim().min(1),
  extensions: z.array(z.string().trim().min(1)),
  mime_types: z.array(z.string().trim().min(1)),
});

const conversationShareCapabilitiesBaseFields = {
  content_block_versions: z.record(z.string(), z.number().int().positive()).optional(),
  ttl_ms: z.number().int().positive(),
  max_rows: z.number().int().positive(),
  max_payload_bytes: z.number().int().positive(),
  max_artifact_count: z.number().int().nonnegative(),
  max_artifact_bytes: z.number().int().positive(),
  max_total_artifact_bytes: z.number().int().positive(),
};

/**
 * Wire response shape: non-strict, with forward-compatible type and access-mode values.
 *
 * As with allowed_artifacts, a new backend access mode must not break capability discovery (and thus
 * the entire publish entry point) on older clients. Discard unknown values while narrowing; a client
 * cannot select a mode it does not recognize.
 */
export const conversationShareCapabilitiesWireSchema = z.object({
  ...conversationShareCapabilitiesBaseFields,
  schema_version: conversationShareSchemaVersionSchema,
  access_modes: z.array(z.string().trim().min(1)),
  allowed_artifacts: z.array(conversationShareAllowedArtifactShapeSchema),
});
export type ConversationShareCapabilitiesWire = z.infer<
  typeof conversationShareCapabilitiesWireSchema
>;

/** Internal shape after narrowing: values are limited to enums recognized by this client and can be validated strictly. */
export const conversationShareCapabilitiesDataSchema = z
  .object({
    ...conversationShareCapabilitiesBaseFields,
    schema_version: conversationShareSchemaVersionSchema,
    access_modes: z.array(conversationShareAccessModeSchema),
    allowed_artifacts: z.array(
      z
        .object({
          type: conversationArtifactTypeSchema,
          extensions: z.array(z.string().trim().min(1)),
          mime_types: z.array(z.string().trim().min(1)),
        })
        .strict(),
    ),
  })
  .strict();
export type ConversationShareCapabilities = z.infer<typeof conversationShareCapabilitiesDataSchema>;

/**
 * Discard artifact types and access modes this client does not recognize, and return the discarded
 * values to the caller for logging.
 *
 * Discarding is lossless only for values the client truly cannot produce or select. If the client can
 * turn an uploadable extension into a preview candidate (see PREVIEW_FILE_TYPES in
 * conversation-preview-artifacts) but has not added its type to conversationArtifactTypeSchema, this
 * will remove a type the server allows and then incorrectly tell the user it is unsupported. Markdown
 * was misclassified this way before. Video/audio are explicit exceptions used only for internal preview
 * warnings and must not be added to the uploadable artifact enum.
 */
export function narrowConversationShareCapabilities(wire: ConversationShareCapabilitiesWire): {
  capabilities: ConversationShareCapabilities;
  unsupportedArtifactTypes: string[];
  unsupportedAccessModes: string[];
} {
  const supported: ConversationShareCapabilities["allowed_artifacts"] = [];
  const unsupportedArtifactTypes: string[] = [];
  for (const entry of wire.allowed_artifacts) {
    const type = conversationArtifactTypeSchema.safeParse(entry.type);
    if (type.success) supported.push({ ...entry, type: type.data });
    else if (!unsupportedArtifactTypes.includes(entry.type))
      unsupportedArtifactTypes.push(entry.type);
  }
  const accessModes: ConversationShareAccessMode[] = [];
  const unsupportedAccessModes: string[] = [];
  for (const mode of wire.access_modes) {
    const parsed = conversationShareAccessModeSchema.safeParse(mode);
    if (parsed.success) accessModes.push(parsed.data);
    else if (!unsupportedAccessModes.includes(mode)) unsupportedAccessModes.push(mode);
  }
  return {
    capabilities: { ...wire, access_modes: accessModes, allowed_artifacts: supported },
    unsupportedArtifactTypes,
    unsupportedAccessModes,
  };
}

export const conversationShareConfirmDataSchema = z.object({
  share_code: z.string().trim().min(1),
  share_url: z.string().url(),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
});
export type ConversationShareRecord = z.infer<typeof conversationShareConfirmDataSchema>;

// Keep outbound requests strict: schema_version is fixed to this client's constant, and an extra field is our bug.
export const conversationSharePreparationRequestSchema = z
  .object({
    client_request_id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    access_mode: conversationShareAccessModeSchema,
    payload_sha256: conversationShareSha256Schema,
    artifact_count: z.number().int().nonnegative(),
  })
  .strict();
export type ConversationSharePreparationRequest = z.infer<
  typeof conversationSharePreparationRequestSchema
>;

const conversationSharePreparationBaseFields = {
  preparation_id: z.string().trim().min(1),
  access_mode: conversationShareAccessModeSchema,
  expires_at: z.number().int().nonnegative(),
} as const;

export const conversationSharePreparationDataSchema = z.discriminatedUnion("status", [
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("preparing"),
  }),
  z.object({
    ...conversationSharePreparationBaseFields,
    status: z.literal("confirmed"),
    share: conversationShareConfirmDataSchema,
  }),
]);
export type ConversationSharePreparation = z.infer<typeof conversationSharePreparationDataSchema>;

export const conversationShareArtifactUploadDataSchema = z.object({
  artifact_id: z.string().trim().min(1),
  size_bytes: z.number().int().nonnegative(),
  sha256: conversationShareSha256Schema,
  status: z.literal("uploaded"),
  safety_status: z.string().trim().min(1),
});
export type ConversationShareArtifactUpload = z.infer<
  typeof conversationShareArtifactUploadDataSchema
>;

const conversationShareIntegrityFields = {
  content_blocks_sha256: conversationShareSha256Schema.optional(),
  projection_sha256: conversationShareSha256Schema,
  artifact_set_sha256: conversationShareSha256Schema,
} as const;

/** Inbound integrity: non-strict so an additional future server digest field does not invalidate the response. */
export const conversationShareIntegritySchema = z.object(conversationShareIntegrityFields);
export type ConversationShareIntegrity = z.infer<typeof conversationShareIntegritySchema>;

/**
 * Outbound integrity: strict. confirm submits only two digests (not payload_sha256); an extra field is
 * our bug and must fail here instead of being sent to production.
 */
const conversationShareOutboundIntegritySchema = z
  .object(conversationShareIntegrityFields)
  .strict();

// Outbound request: validate rows with the formal row schema and keep the request strict; we must fully understand every projection we send.
export const conversationShareConfirmRequestSchema = z
  .object({
    selected_product_turn_ids: z.array(z.string().trim().min(1)).min(1),
    projection: z
      .object({
        rows: z.array(conversationRowSchema).min(1),
        content_blocks: z
          .array(conversationShareContentBlockSchema)
          .min(1)
          .max(SHARE_CONTENT_LIMITS.blocks)
          .optional(),
      })
      .strict(),
    integrity: conversationShareOutboundIntegritySchema,
    disclosure_confirmation: z
      .object({
        version: z.literal(1),
        accepted_at: z.number().int().nonnegative(),
        acknowledged_no_secret_detection: z.literal(true),
      })
      .strict(),
  })
  .strict();
export type ConversationShareConfirmRequest = z.infer<typeof conversationShareConfirmRequestSchema>;

const conversationSharePublicMetadataSchema = z.object({
  title: z.string(),
  access_mode: conversationShareAccessModeSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
});

export const conversationSharePreviewArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    // 公开 URL 会进入链接、媒体及 fetch，不允许 API 响应启动其它协议。
    url: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//iu.test(url)),
    url_expires_at: z.number().int().nonnegative(),
  });

/**
 * Inbound wire shape: rows are unknown[] and decodeConversationShareRows downgrades them individually.
 *
 * The transport layer intentionally does not interpret row semantics; otherwise an older client would
 * be unable to open an entire share when it encounters one row with a new kind. The public type
 * ConversationSharePreview represents the decoded shape and is not inferred from this schema.
 */
export const conversationSharePreviewDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  share: conversationSharePublicMetadataSchema,
  rows: z.array(z.unknown()),
  content_blocks: z.array(z.unknown()).optional(),
  artifacts: z.array(conversationSharePreviewArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationSharePreviewWire = z.infer<typeof conversationSharePreviewDataSchema>;
export type ConversationSharePreview = Omit<ConversationSharePreviewWire, "rows"> & {
  rows: ConversationRow[];
  /** Number of rows skipped because this client does not recognize them; when >0, the UI must show a soft warning that some content requires an updated ZCode. */
  unsupportedRowCount: number;
};

export const conversationShareContinuationRequestSchema = z
  .object({
    schema_version: z.literal(CONVERSATION_SHARE_SCHEMA_VERSION),
    client_request_id: z.string().trim().min(1),
  })
  .strict();
export type ConversationShareContinuationRequest = z.infer<
  typeof conversationShareContinuationRequestSchema
>;

export const conversationShareContinuationArtifactSchema =
  conversationShareInboundArtifactDescriptorSchema.extend({
    download_url: conversationSharePreviewArtifactSchema.shape.url,
    download_url_expires_at: z.number().int().nonnegative(),
  });

export const conversationShareContinuationDataSchema = z.object({
  schema_version: conversationShareSchemaVersionSchema,
  import_grant_id: z.string().trim().min(1),
  import_grant_expires_at: z.number().int().nonnegative(),
  share: conversationSharePublicMetadataSchema.extend({
    share_id: z.string().trim().min(1),
  }),
  rows: z.array(z.unknown()),
  content_blocks: z.array(z.unknown()).optional(),
  artifacts: z.array(conversationShareContinuationArtifactSchema),
  integrity: conversationShareIntegritySchema,
});
export type ConversationShareContinuationWire = z.infer<
  typeof conversationShareContinuationDataSchema
>;
export type ConversationShareContinuation = Omit<ConversationShareContinuationWire, "rows"> & {
  rows: ConversationRow[];
  /** Unparsed raw rows, preserved as-is in the on-disk read-only copy so unknown fields are not permanently lost by this client. */
  rawRows: readonly unknown[];
  /** Number of rows skipped because this client does not recognize them; when >0, the UI must show a soft warning that some content requires an updated ZCode. */
  unsupportedRowCount: number;
};

/** Business error codes known to this client; do not enum-validate on the wire, so unknown codes retain the server msg and map to unknown. */
export const conversationShareKnownErrorCodeSchema = z.union([
  z.literal(3001),
  z.literal(3002),
  z.literal(3200),
  z.literal(3201),
  z.literal(3203),
  z.literal(3204),
  z.literal(3205),
  z.literal(3206),
  z.literal(3207),
  z.literal(3208),
  z.literal(3209),
  z.literal(3210),
  z.literal(3211),
  z.literal(3212),
  z.literal(3213),
  z.literal(3214),
  z.literal(3215),
  z.literal(3216),
  z.literal(3217),
]);
export type ConversationShareApiErrorCode = z.infer<typeof conversationShareKnownErrorCodeSchema>;

const SHARE_ERROR_KIND_BY_CODE = {
  3001: "invalid_contract",
  3002: "rate_limited",
  3200: "feature_disabled",
  3201: "authentication_required",
  3203: "unsupported_schema_version",
  3204: "invalid_contract",
  3205: "invalid_conversation",
  3206: "disclosure_required",
  3207: "unsafe_structure",
  3208: "artifact_not_allowed",
  3209: "limit_exceeded",
  3210: "upload_incomplete",
  3211: "not_found",
  3212: "expired",
  3213: "authentication_required",
  3214: "import_not_allowed",
  3215: "safety_check_pending",
  3216: "safety_check_rejected",
  3217: "safety_check_unavailable",
} as const satisfies Record<ConversationShareApiErrorCode, string>;

export type ConversationShareErrorKind =
  | (typeof SHARE_ERROR_KIND_BY_CODE)[ConversationShareApiErrorCode]
  | "service_unavailable"
  | "network"
  | "unknown";

/** 桌面与网页共享分类；错误码表达业务语义，未知码仍按 HTTP 判断服务故障。 */
export function classifyConversationShareError(
  status: number,
  code?: number,
): ConversationShareErrorKind {
  const known = conversationShareKnownErrorCodeSchema.safeParse(code);
  if (known.success) return SHARE_ERROR_KIND_BY_CODE[known.data];
  if (status === 401) return "authentication_required";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_unavailable";
  if (status === 403 || status === 404) return "not_found";
  if (status === 410) return "expired";
  if (status === 413) return "limit_exceeded";
  // HTTP 拒绝与响应契约损坏分开；仅成功响应缺少契约时归为 invalid_contract。
  return status >= 200 && status < 300 && code === undefined ? "invalid_contract" : "unknown";
}

const rejectionCoordinateSchema = z
  .string()
  .min(1)
  .max(65)
  .regex(/^[A-Za-z0-9_.[\]~-]+$/u);
export const conversationShareRejectionSchema = z.object({
  rule: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/u),
  path: rejectionCoordinateSchema.optional().catch(undefined),
  field: rejectionCoordinateSchema.optional().catch(undefined),
  row_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
  row_kind: rejectionCoordinateSchema.optional().catch(undefined),
});
export type ConversationShareRejection = z.infer<typeof conversationShareRejectionSchema>;

export const conversationShareRequestIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/u);

/**
 * Do not enum-validate code in the error envelope. When the backend adds a business code, older clients
 * should still receive the server msg instead of failing to parse the envelope and degrading it to a
 * context-free "HTTP 4xx".
 */
export const conversationShareErrorEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  logid: conversationShareRequestIdSchema.optional().catch(undefined),
  data: conversationShareRejectionSchema.optional().catch(undefined),
});
export type ConversationShareErrorEnvelope = z.infer<typeof conversationShareErrorEnvelopeSchema>;

export function createConversationShareSuccessEnvelopeSchema<TSchema extends z.ZodType>(
  dataSchema: TSchema,
) {
  return z.object({
    code: z.literal(0),
    // msg used to be z.literal(""). If the backend ever returned "ok", every successful response would
    // be treated as a contract error.
    msg: z.string(),
    data: dataSchema,
  });
}
