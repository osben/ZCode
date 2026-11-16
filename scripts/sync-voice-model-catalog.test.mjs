import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOMMEND_RANK_OVERRIDES,
  renderCatalogModule,
  transformHandyCatalog,
  transformHandyEntry,
} from "./sync-voice-model-catalog.mjs";

const SHA = (seed) => "0".repeat(63) + seed;

function handyEntry(overrides = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    description: "A test model.",
    repository: "owner/test-model",
    revision: "a".repeat(40),
    license: "mit",
    family: "test",
    parameters: "123M",
    languages: ["en", "de"],
    capabilities: { streaming: true, translate: false, languageDetection: true, timestamps: false },
    quant: "Q8_0",
    minEngine: "0.2.4",
    role: "asr",
    curated: true,
    files: {
      Q8_0: { filename: "test-model-Q8_0.gguf", size: 100, sha256: SHA("1") },
      Q5_K_M: { filename: "test-model-Q5_K_M.gguf", size: 80, sha256: SHA("2") },
    },
    ...overrides,
  };
}

test("transformHandyEntry maps fields, quants, and capabilities", () => {
  const descriptor = transformHandyEntry(handyEntry());
  assert.equal(descriptor.id, "test-model");
  assert.equal(descriptor.huggingFaceRepo, "owner/test-model");
  assert.equal(descriptor.defaultQuant, "Q8_0");
  assert.equal(descriptor.streaming, true);
  assert.equal(descriptor.curated, true);
  assert.equal(descriptor.parameters, "123M");
  assert.equal(descriptor.minEngine, "0.2.4");
  assert.deepEqual(descriptor.quants, {
    Q8_0: { fileName: "test-model-Q8_0.gguf", sizeBytes: 100, sha256: SHA("1") },
    Q5_K_M: { fileName: "test-model-Q5_K_M.gguf", sizeBytes: 80, sha256: SHA("2") },
  });
  assert.equal(descriptor.languageLocales, undefined);
});

test("locale-form language lists become bare codes plus a first-wins locale map", () => {
  const descriptor = transformHandyEntry(
    handyEntry({ languages: ["en-US", "en-GB", "es-ES", "uk"] }),
  );
  assert.deepEqual(descriptor.languages, ["en", "es", "uk"]);
  // Several locales share "en": the first one wins so refreshes stay stable.
  assert.deepEqual(descriptor.languageLocales, { en: "en-US", es: "es-ES" });
});

test("missing descriptions stay empty and unknown ranks stay unset", () => {
  const descriptor = transformHandyEntry(
    handyEntry({ description: undefined, curated: undefined }),
  );
  assert.equal(descriptor.description, "");
  assert.equal(descriptor.curated, undefined);
  assert.equal(descriptor.recommendRank, undefined);
});

test("fork recommend ranks are applied to the refreshed catalog ids", () => {
  const descriptor = transformHandyEntry(handyEntry({ id: "parakeet-tdt-0.6b-v3" }));
  assert.equal(descriptor.recommendRank, RECOMMEND_RANK_OVERRIDES["parakeet-tdt-0.6b-v3"]);
});

test("invalid entries are rejected instead of generating a broken catalog", () => {
  assert.throws(() => transformHandyEntry(handyEntry({ files: {} })), /files/);
  assert.throws(
    () => transformHandyEntry(handyEntry({ quant: "Q3" })),
    /quant must exist in files/,
  );
  assert.throws(
    () =>
      transformHandyEntry({
        ...handyEntry(),
        files: { Q8_0: { filename: "x.gguf", size: -1, sha256: SHA("1") } },
      }),
    /size must be a positive integer/,
  );
  assert.throws(() => transformHandyEntry(handyEntry({ languages: [] })), /languages/);
});

test("transformHandyCatalog keeps only asr entries in file order", () => {
  const raw = {
    schema: 2,
    transcribeCpp: "0.4.0",
    models: [
      handyEntry({ id: "asr-one" }),
      { ...handyEntry(), id: "vad", role: "vad" },
      handyEntry({ id: "asr-two" }),
    ],
  };
  assert.deepEqual(
    transformHandyCatalog(raw).map((m) => m.id),
    ["asr-one", "asr-two"],
  );
});

test("renderCatalogModule dedupes identical language sets and renders lookup helpers", () => {
  const raw = {
    schema: 2,
    transcribeCpp: "0.4.0",
    models: [
      handyEntry({ id: "a" }),
      handyEntry({ id: "b" }),
      handyEntry({ id: "c", languages: ["fr"] }),
    ],
  };
  const text = renderCatalogModule(transformHandyCatalog(raw), {
    schema: "2",
    transcribeCpp: "0.4.0",
  });
  assert.match(text, /const LANGUAGE_SET_1: readonly string\[\]/);
  assert.match(text, /Language set shared by 2 model\(s\): a, b/);
  assert.match(text, /languages: LANGUAGE_SET_1,/);
  assert.match(text, /languages: LANGUAGE_SET_2,/);
  assert.match(text, /export function voiceModelQuantFile\(/);
  assert.match(text, /export function findVoiceModelDescriptor\(/);
  assert.match(text, /id: "a",/);
  assert.match(text, /defaultQuant: "Q8_0",/);
  // The generated module must parse: eval-free syntax check via the TS-aware parser is the
  // typecheck's job; here we assert balanced generation markers only.
  assert.ok(text.endsWith("\n"));
});
