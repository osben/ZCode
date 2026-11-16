#!/usr/bin/env node
// Regenerates packages/services/src/voice-dictation/voiceModelCatalog.ts from the Handy
// (cjpais/Handy, MIT) model catalog. Run manually when refreshing the model list:
//
//   node scripts/sync-voice-model-catalog.mjs [source]
//
// `source` is a URL or a local catalog.json path (default: Handy main). The generated file is
// committed; pure transform/render functions are exported for the fixture test
// (scripts/sync-voice-model-catalog.test.mjs).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/cjpais/Handy/main/src-tauri/src/catalog/catalog.json";
const OUTPUT_PATH = new URL(
  "../packages/services/src/voice-dictation/voiceModelCatalog.ts",
  import.meta.url,
).pathname;

/**
 * Fork-only recommendation ranks (lower shows first among models covering the selected
 * languages). Deliberately not re-tuned on catalog refresh; adjust here when ranking changes.
 */
export const RECOMMEND_RANK_OVERRIDES = {
  "parakeet-unified-en-0.6b": 1,
  "parakeet-tdt-0.6b-v3": 2,
  "canary-180m-flash": 3,
  "whisper-large-v3-turbo": 4,
  "whisper-medium": 5,
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function assertValid(entry, field, value, predicate, message) {
  if (!predicate(value)) {
    throw new Error(`catalog entry ${entry.id}: ${field} ${message}`);
  }
}

/**
 * Maps one Handy catalog entry to the fork descriptor shape: locale-form language lists become
 * bare codes plus a `languageLocales` map, and per-quantization files become the `quants` record.
 */
export function transformHandyEntry(entry) {
  if (typeof entry?.id !== "string" || entry.id === "") {
    throw new Error("catalog entry without an id");
  }
  for (const field of [
    "name",
    "family",
    "repository",
    "revision",
    "license",
    "quant",
    "minEngine",
  ]) {
    assertValid(
      entry,
      field,
      entry[field],
      (v) => typeof v === "string" && v !== "",
      "must be a non-empty string",
    );
  }
  const rawLanguages = Array.isArray(entry.languages) ? entry.languages : [];
  assertValid(entry, "languages", rawLanguages, (v) => v.length > 0, "must be a non-empty array");
  const languageLocales = {};
  const languages = [];
  for (const code of rawLanguages) {
    assertValid(
      entry,
      `languages[${code}]`,
      code,
      (v) => typeof v === "string" && v !== "",
      "must be a non-empty string",
    );
    const bare = code.includes("-") ? code.split("-", 1)[0] : code;
    // Several locales can share a bare code (en-US + en-GB); the first one wins — any accepted
    // locale satisfies the native layer, and first-wins keeps the mapping stable across refreshes.
    if (code.includes("-") && languageLocales[bare] === undefined) languageLocales[bare] = code;
    if (!languages.includes(bare)) languages.push(bare);
  }
  const capabilities = entry.capabilities ?? {};
  const files = entry.files ?? {};
  const quantIds = Object.keys(files);
  assertValid(entry, "files", quantIds, (v) => v.length > 0, "must be a non-empty object");
  assertValid(entry, "quant", entry.quant, (v) => quantIds.includes(v), "must exist in files");
  const quants = {};
  for (const quant of quantIds) {
    const file = files[quant];
    assertValid(
      entry,
      `files[${quant}].filename`,
      file?.filename,
      (v) => typeof v === "string" && v !== "",
      "must be a non-empty string",
    );
    assertValid(
      entry,
      `files[${quant}].size`,
      file?.size,
      (v) => Number.isInteger(v) && v > 0,
      "must be a positive integer",
    );
    assertValid(
      entry,
      `files[${quant}].sha256`,
      file?.sha256,
      (v) => SHA256_PATTERN.test(v),
      "must be a sha256 hex digest",
    );
    quants[quant] = { fileName: file.filename, sizeBytes: file.size, sha256: file.sha256 };
  }
  const descriptor = {
    id: entry.id,
    name: entry.name,
    description: typeof entry.description === "string" ? entry.description : "",
    family: entry.family,
    languages,
    streaming: capabilities.streaming === true,
    license: entry.license,
    huggingFaceRepo: entry.repository,
    revision: entry.revision,
    minEngine: entry.minEngine,
    defaultQuant: entry.quant,
    quants,
  };
  if (typeof entry.parameters === "string" && entry.parameters !== "") {
    descriptor.parameters = entry.parameters;
  }
  if (Object.keys(languageLocales).length > 0) {
    descriptor.languageLocales = languageLocales;
  }
  if (entry.curated === true) {
    descriptor.curated = true;
  }
  const recommendRank = RECOMMEND_RANK_OVERRIDES[entry.id];
  if (recommendRank !== undefined) {
    descriptor.recommendRank = recommendRank;
  }
  return descriptor;
}

/** Handy catalog (top-level object) → fork descriptors for every `role: "asr"` entry, in file order. */
export function transformHandyCatalog(raw) {
  if (!Array.isArray(raw?.models)) throw new Error("catalog is missing the models array");
  return raw.models
    .filter((entry) => entry.role === "asr")
    .map((entry) => transformHandyEntry(entry));
}

function renderLanguageConsts(models) {
  const consts = [];
  const indexByContent = new Map();
  for (const model of models) {
    const key = [...model.languages].sort().join("\n");
    if (indexByContent.has(key)) continue;
    indexByContent.set(key, consts.length + 1);
    const users = models
      .filter((candidate) => {
        const candidateKey = [...candidate.languages].sort().join("\n");
        return candidateKey === key;
      })
      .map((candidate) => candidate.id);
    consts.push({
      name: `LANGUAGE_SET_${consts.length + 1}`,
      languages: model.languages,
      users,
    });
  }
  return { consts, indexByContent };
}

function renderStringArray(values, indent) {
  const pad = " ".repeat(indent);
  const lines = values.map((value) => `${pad}  "${value}",`);
  return `[\n${lines.join("\n")}\n${pad}]`;
}

function renderLanguageLocales(locales) {
  const entries = Object.entries(locales).map(([bare, locale]) => `      ${bare}: "${locale}",`);
  return `{\n${entries.join("\n")}\n    }`;
}

function renderQuants(quants) {
  const blocks = Object.entries(quants).map(([quant, file]) => {
    return `      ${quant}: { fileName: "${file.fileName}", sizeBytes: ${file.sizeBytes}, sha256: "${file.sha256}" },`;
  });
  return `{\n${blocks.join("\n")}\n    }`;
}

/** Renders the complete generated module (interfaces + data + lookup helper). */
export function renderCatalogModule(models, meta) {
  const { consts, indexByContent } = renderLanguageConsts(models);
  const languageLines = consts.map((constant) => {
    return `/** Language set shared by ${constant.users.length} model(s): ${constant.users.join(", ")} */\nconst ${constant.name}: readonly string[] = ${renderStringArray(constant.languages, 0)};`;
  });
  const modelBlocks = models.map((model) => {
    const key = [...model.languages].sort().join("\n");
    const languageRef = `LANGUAGE_SET_${indexByContent.get(key)}`;
    const fields = [
      `    id: "${model.id}",`,
      `    name: "${model.name}",`,
      `    description: ${JSON.stringify(model.description)},`,
      `    family: "${model.family}",`,
    ];
    if (model.parameters !== undefined) {
      fields.push(`    parameters: "${model.parameters}",`);
    }
    fields.push(`    languages: ${languageRef},`);
    if (model.languageLocales !== undefined) {
      fields.push(`    languageLocales: ${renderLanguageLocales(model.languageLocales)},`);
    }
    fields.push(`    streaming: ${model.streaming},`);
    if (model.curated === true) fields.push(`    curated: true,`);
    if (model.recommendRank !== undefined)
      fields.push(`    recommendRank: ${model.recommendRank},`);
    fields.push(
      `    license: "${model.license}",`,
      `    huggingFaceRepo: "${model.huggingFaceRepo}",`,
      `    revision: "${model.revision}",`,
      `    minEngine: "${model.minEngine}",`,
      `    defaultQuant: "${model.defaultQuant}",`,
      `    quants: ${renderQuants(model.quants)},`,
    );
    return `  {\n${fields.join("\n")}\n  },`;
  });
  return `/* eslint-disable max-lines -- Generated model catalog: one entry per Handy model with per-quantization trust anchors. */
// GENERATED FILE — do not edit by hand. Regenerate with:
//   node scripts/sync-voice-model-catalog.mjs
// Source: cjpais/Handy src-tauri/src/catalog/catalog.json (MIT), schema ${meta.schema},
// targeting transcribe-cpp ${meta.transcribeCpp}. Descriptors are generated for every
// role:"asr" model; trust anchors are the per-quantization sha256 values.

export interface VoiceModelQuantFile {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface VoiceModelDescriptor {
  id: string;
  name: string;
  /** English catalog description; empty when Handy publishes none (the UI hides the line). */
  description: string;
  family: string;
  /** Approximate parameter count as published by the catalog (e.g. "627M"). */
  parameters?: string;
  /** ISO 639-1 codes the model supports. */
  languages: readonly string[];
  /**
   * Maps a bare language code to the locale the native layer accepts, for models whose catalog
   * entry lists locales (checked against transcribe-cpp; \`capabilities.languages\` is garbled by
   * the binding, so this is static data).
   */
  languageLocales?: Readonly<Record<string, string>>;
  /** Live transcription as published by the Handy catalog; the runtime still probes the loaded model before streaming. */
  streaming: boolean;
  /** Handy marks hand-picked models; shown as a badge, never affects behavior. */
  curated?: boolean;
  /** Lower is recommended first among models covering the selected languages; absent means never recommended. */
  recommendRank?: number;
  license: string;
  huggingFaceRepo: string;
  revision: string;
  /** First transcribe-cpp version that can load this model (catalog minEngine). */
  minEngine: string;
  /** Quantization used when the user has not chosen one. */
  defaultQuant: string;
  /** Downloadable files keyed by quantization. */
  quants: Readonly<Record<string, VoiceModelQuantFile>>;
}

${languageLines.join("\n\n")}

export const VOICE_MODEL_CATALOG: readonly VoiceModelDescriptor[] = [
${modelBlocks.join("\n")}
];

/** Resolves the file entry for a quantization; the descriptor default when \`quant\` is omitted. */
export function voiceModelQuantFile(
  descriptor: VoiceModelDescriptor,
  quant?: string,
): VoiceModelQuantFile {
  const resolved = quant ?? descriptor.defaultQuant;
  const file = descriptor.quants[resolved];
  if (!file) {
    throw new Error(\`voice model \${descriptor.id} has no quantization \${resolved}\`);
  }
  return file;
}

export function findVoiceModelDescriptor(
  id: string,
  catalog: readonly VoiceModelDescriptor[] = VOICE_MODEL_CATALOG,
): VoiceModelDescriptor | undefined {
  return catalog.find((model) => model.id === id);
}
`;
}

async function loadSource(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`fetching ${source} failed: HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

async function main() {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const raw = await loadSource(source);
  const models = transformHandyCatalog(raw);
  const moduleText = renderCatalogModule(models, {
    schema: String(raw.schema ?? "unknown"),
    transcribeCpp: String(raw.transcribeCpp ?? "unknown"),
  });
  writeFileSync(OUTPUT_PATH, moduleText);
  // The renderer does not replicate oxfmt's line-width decisions; format the output so a
  // regeneration is byte-identical to the committed file.
  const oxfmt = new URL("../node_modules/.bin/oxfmt", import.meta.url).pathname;
  const formatted = spawnSync(oxfmt, [OUTPUT_PATH], { stdio: "inherit" });
  if (formatted.status !== 0) {
    throw new Error(`oxfmt failed with exit code ${formatted.status}`);
  }
  console.log(`generated ${OUTPUT_PATH}: ${models.length} ASR models from ${source}`);
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
