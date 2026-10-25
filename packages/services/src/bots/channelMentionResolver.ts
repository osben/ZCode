import { createHash } from "node:crypto";
import {
  channelMentionSchema,
  resolveChannelReplyParts,
  type ChannelContentPart,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";

type Mention = Extract<ChannelContentPart, { type: "channelMention" }>;
type Clarification = Extract<ChannelReplyResult, { status: "needs_clarification" }>;
const MAX_CANDIDATES = 10;
const normalizeName = (name: string) => name.normalize("NFKC").trim().toLowerCase();

/** Names are only query criteria; candidate identities may only come from the provider directory and authorized native mentions. */
export function resolveChannelMentionNames(
  parts: ChannelReplyHostRequest["parts"],
  trusted: ChannelContentPart[],
  members: Record<string, string> | undefined,
  scope: string,
  channel: "feishu" | "lark",
  nameCandidates: ChannelContentPart[] = [],
): { parts: ChannelContentPart[] } | Clarification {
  const nodes: Mention[] = [...trusted, ...nameCandidates].filter(
    (part): part is Mention => part.type === "channelMention",
  );
  for (const [targetId, name] of Object.entries(members ?? {})) {
    const node = channelMentionSchema.safeParse({
      type: "channelMention",
      targetId,
      name,
      channel,
      refId: "directory",
      idType: "open_id",
      entityType: "user",
    });
    if (node.success) nodes.push(node.data);
  }
  const resolved: ChannelContentPart[] = [];
  const unresolved: Clarification["unresolved"] = [];
  for (const part of parts) {
    if (part.type !== "mentionName") {
      // Resolve trusted refs by original semantics; never treat a model-provided name as a ref/platform ID.
      if (part.type === "text") resolved.push(part);
      else resolved.push(...resolveChannelReplyParts([part], trusted));
      continue;
    }
    const byId = new Map<string, Mention>();
    for (const node of nodes) {
      if (
        node.channel === channel &&
        normalizeName(part.name) &&
        normalizeName(node.name).includes(normalizeName(part.name))
      )
        byId.set(node.targetId, node);
    }
    const candidates = [...byId.values()]
      .sort((a, b) => a.targetId.localeCompare(b.targetId))
      .map((node) => ({
        node,
        ref: `name:${createHash("sha256")
          .update(JSON.stringify([scope, node.targetId]))
          .digest("hex")}`,
      }));
    const exact = candidates.filter(
      ({ node }) => normalizeName(node.name) === normalizeName(part.name),
    );
    const automatic =
      exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    const selected = part.candidateRef
      ? candidates.find((candidate) => candidate.ref === part.candidateRef)
      : automatic;
    // A failed lookup must not treat an incomplete candidate set as a unique match; the same applies when trusted bot mentions exist.
    if (members && selected) {
      resolved.push({ ...selected.node, refId: selected.ref });
      continue;
    }
    // Previously the first failure returned early, letting the model report unqueried names as success; all failures must be collected.
    unresolved.push({
      name: part.name,
      reason: !members
        ? "unavailable"
        : part.candidateRef
          ? "selection_expired"
          : candidates.length
            ? "ambiguous"
            : "not_found",
      candidates: members
        ? candidates.slice(0, MAX_CANDIDATES).map(({ node, ref }) => ({
            ref,
            name: node.name,
            kind: node.entityType,
            label: `${node.name} (${node.entityType}, …${node.targetId.slice(-6)})`,
          }))
        : [],
      truncated: candidates.length > MAX_CANDIDATES,
    });
  }
  return unresolved.length ? { status: "needs_clarification", unresolved } : { parts: resolved };
}
