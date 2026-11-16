import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_MODEL_CATALOG } from "../src/voice-dictation/voiceModelCatalog.js";
import {
  engineLanguageFor,
  filterVoiceModels,
  isLiveStreamingModel,
  isVoiceModelDownloading,
  isVoiceModelReady,
  languageSettingsPatch,
  missingVoiceLanguages,
  modelSupportsVoiceLanguages,
  recommendVoiceModel,
  resolveVoiceLanguages,
  sortVoiceModels,
  toNativeLanguage,
  type VoiceModelLike,
} from "../src/voice-dictation/voiceModelLanguages.js";

const model = (overrides: Partial<VoiceModelLike> & { id: string }): VoiceModelLike => ({
  name: overrides.id,
  family: "whisper",
  streaming: false,
  languages: ["en"],
  ...overrides,
});

const WHISPER = model({ id: "whisper", languages: ["en", "uk", "ru", "ja"], recommendRank: 3 });
const TDT = model({
  id: "tdt",
  family: "parakeet",
  languages: ["en", "uk", "ru"],
  recommendRank: 2,
});
const EN_LIVE = model({
  id: "en-live",
  family: "parakeet",
  streaming: true,
  languages: ["en"],
  recommendRank: 1,
});
// A model the catalog does not flag as runtime-verified: never advertised as streaming whatever its family.
const NEMOTRON = model({ id: "nemotron", family: "nemotron", streaming: false, languages: ["en"] });
const CATALOG = [WHISPER, TDT, EN_LIVE, NEMOTRON];

test("resolveVoiceLanguages prefers languages, falls back to the legacy single language", () => {
  assert.deepEqual(resolveVoiceLanguages({ languages: [" uk ", "en", "uk", "auto", ""] }), [
    "uk",
    "en",
  ]);
  assert.deepEqual(resolveVoiceLanguages({ languages: [], language: "uk" }), []);
  assert.deepEqual(resolveVoiceLanguages({ language: "uk" }), ["uk"]);
  assert.deepEqual(resolveVoiceLanguages({ language: "auto" }), []);
  assert.deepEqual(resolveVoiceLanguages({}), []);
});

test("engineLanguageFor forces a single language and leaves several to auto-detection", () => {
  assert.equal(engineLanguageFor([]), "auto");
  assert.equal(engineLanguageFor(["uk"]), "uk");
  assert.equal(engineLanguageFor(["uk", "en"]), "auto");
});

test("languageSettingsPatch writes languages and the legacy mirror together", () => {
  assert.deepEqual(languageSettingsPatch(["uk"]), { languages: ["uk"], language: "uk" });
  assert.deepEqual(languageSettingsPatch(["uk", "en"]), {
    languages: ["uk", "en"],
    language: "auto",
  });
  assert.deepEqual(languageSettingsPatch([]), { languages: [], language: "auto" });
});

test("coverage helpers report which selected languages a model lacks", () => {
  assert.deepEqual(missingVoiceLanguages(TDT, ["uk", "ja"]), ["ja"]);
  assert.equal(modelSupportsVoiceLanguages(WHISPER, ["uk", "ja"]), true);
  assert.equal(modelSupportsVoiceLanguages(TDT, ["uk", "ja"]), false);
  assert.equal(modelSupportsVoiceLanguages(TDT, []), true);
});

test("recommendVoiceModel picks the best-ranked model covering every selected language", () => {
  assert.equal(recommendVoiceModel(CATALOG, ["en"])?.id, "en-live");
  assert.equal(recommendVoiceModel(CATALOG, ["uk"])?.id, "tdt");
  assert.equal(recommendVoiceModel(CATALOG, ["uk", "ja"])?.id, "whisper");
  assert.equal(recommendVoiceModel(CATALOG, ["xx"]), null);
  assert.equal(recommendVoiceModel(CATALOG, []), null);
});

test("recommendVoiceModel ignores models without a rank", () => {
  assert.equal(recommendVoiceModel([NEMOTRON], ["en"]), null);
});

test("isLiveStreamingModel follows the runtime-verified catalog flag, not the family", () => {
  assert.equal(isLiveStreamingModel(EN_LIVE), true);
  assert.equal(isLiveStreamingModel(NEMOTRON), false);
  assert.equal(isLiveStreamingModel(WHISPER), false);
  assert.equal(isLiveStreamingModel(TDT), false);
});

test("catalog streaming flags match the Handy-published streaming models", () => {
  const streaming = VOICE_MODEL_CATALOG.filter(isLiveStreamingModel).map((m) => m.id);
  assert.deepEqual(streaming.sort(), [
    "Voxtral-Mini-4B-Realtime-2602",
    "moonshine-streaming-medium",
    "moonshine-streaming-small",
    "moonshine-streaming-tiny",
    "multitalker-parakeet-streaming-0.6b-v1",
    "nemotron-3.5-asr-streaming-0.6b",
    "nemotron-speech-streaming-en-0.6b",
    "parakeet-unified-en-0.6b",
  ]);
});

test("nemotron 3.5 declares a locale for every language and covers uk/ru/en", () => {
  const nemotron = VOICE_MODEL_CATALOG.find((m) => m.id === "nemotron-3.5-asr-streaming-0.6b")!;
  assert.equal(nemotron.languages.length, 28);
  assert.deepEqual(
    Object.keys(nemotron.languageLocales ?? {}).sort(),
    [...nemotron.languages].sort(),
  );
  for (const [code, locale] of Object.entries(nemotron.languageLocales ?? {})) {
    assert.match(locale, new RegExp(`^${code}-[A-Z]{2}$`));
  }
  assert.equal(modelSupportsVoiceLanguages(nemotron, ["uk", "ru", "en"]), true);
});

test("toNativeLanguage maps codes to locales only for models that need them", () => {
  const nemotron = VOICE_MODEL_CATALOG.find((m) => m.id === "nemotron-3.5-asr-streaming-0.6b");
  assert.equal(toNativeLanguage(nemotron, "uk"), "uk-UA");
  assert.equal(toNativeLanguage(nemotron, "ru"), "ru-RU");
  // The native layer rejects bare codes for this model, so a code it does not map falls back to
  // automatic detection instead of failing every recording.
  assert.equal(toNativeLanguage(nemotron, "xx"), undefined);
  assert.equal(toNativeLanguage(nemotron, "ca"), undefined);
  assert.equal(toNativeLanguage(nemotron, undefined), undefined);
  assert.equal(toNativeLanguage(undefined, "uk"), "uk");
  assert.equal(toNativeLanguage({}, "en"), "en");
});

const items = CATALOG.map((descriptor, index) => ({
  descriptor,
  states: {
    Q8_0: {
      status: index === 1 ? ("ready" as const) : ("not_downloaded" as const),
    },
    Q4_K_M: {
      status:
        index === 0
          ? ("ready" as const)
          : index === 1
            ? ("downloading" as const)
            : ("not_downloaded" as const),
    },
  },
}));
const languageName = (code: string) =>
  ({ en: "English", uk: "Ukrainian", ru: "Russian" })[code] ?? code;
const baseFilter = { query: "", languages: [], downloadedOnly: false, streamingOnly: false };

test("filterVoiceModels narrows by language, downloaded, streaming, and text", () => {
  const ids = (filter: Partial<typeof baseFilter>) =>
    filterVoiceModels(items, { ...baseFilter, ...filter }, languageName).map(
      (i) => i.descriptor.id,
    );

  assert.deepEqual(ids({}), ["whisper", "tdt", "en-live", "nemotron"]);
  assert.deepEqual(ids({ languages: ["uk"] }), ["whisper", "tdt"]);
  assert.deepEqual(ids({ languages: ["uk", "ja"] }), ["whisper"]);
  // "Downloaded" means any quantization is ready: whisper is ready on Q4_K_M, tdt on its default.
  assert.deepEqual(ids({ downloadedOnly: true }), ["whisper", "tdt"]);
  assert.deepEqual(ids({ streamingOnly: true }), ["en-live"]);
  assert.deepEqual(ids({ query: "  UKRAINIAN " }), ["whisper", "tdt"]);
  assert.deepEqual(ids({ query: "nemo" }), ["nemotron"]);
  assert.deepEqual(ids({ query: "parakeet" }), ["tdt", "en-live"]);
  assert.deepEqual(ids({ query: "zzz" }), []);
});

test("sortVoiceModels puts the recommendation first and keeps catalog order otherwise", () => {
  assert.deepEqual(
    sortVoiceModels(items, "en-live").map((i) => i.descriptor.id),
    ["en-live", "whisper", "tdt", "nemotron"],
  );
  assert.deepEqual(
    sortVoiceModels(items, null).map((i) => i.descriptor.id),
    ["whisper", "tdt", "en-live", "nemotron"],
  );
});

test("catalog entries are well-formed and expose explicit unique language codes", () => {
  const ids = new Set<string>();
  const quantPattern = /^(F32|F16|BF16|Q8_0|Q6_K|Q5_K_M|Q4_K_M)$/;
  for (const entry of VOICE_MODEL_CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.revision, /^[0-9a-f]{40}$/, entry.id);
    assert.ok(entry.languages.length > 0, `${entry.id} has no languages`);
    assert.equal(
      new Set(entry.languages).size,
      entry.languages.length,
      `${entry.id} repeats a code`,
    );
    for (const code of entry.languages) assert.match(code, /^[a-z]{2,3}$/, `${entry.id}: ${code}`);
    assert.ok(entry.defaultQuant in entry.quants, `${entry.id}: defaultQuant missing from quants`);
    assert.match(entry.minEngine, /^\d+\.\d+\.\d+$/, `${entry.id}: minEngine`);
    for (const [quant, file] of Object.entries(entry.quants)) {
      assert.match(quant, quantPattern, `${entry.id}: ${quant}`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${entry.id}/${quant}: sha256`);
      assert.ok(file.sizeBytes > 0, `${entry.id}/${quant}: size`);
      assert.ok(file.fileName.length > 0, `${entry.id}/${quant}: fileName`);
    }
  }
});

test("the catalog keeps every legacy model id so stored selections stay valid", () => {
  const ids = new Set(VOICE_MODEL_CATALOG.map((entry) => entry.id));
  for (const id of [
    "whisper-tiny",
    "whisper-base",
    "whisper-small",
    "whisper-medium",
    "whisper-large-v3",
    "whisper-large-v3-turbo",
    "parakeet-unified-en-0.6b",
    "parakeet-tdt-0.6b-v3",
    "canary-180m-flash",
    "canary-1b-v2",
    "nemotron-speech-streaming-en-0.6b",
    "nemotron-3.5-asr-streaming-0.6b",
    "gigaam-v3-e2e-rnnt",
  ]) {
    assert.ok(ids.has(id), `missing legacy model id ${id}`);
  }
});

test("ready and downloading helpers look across every quantization", () => {
  const [readyOnOtherQuant, mixed] = items;
  assert.equal(isVoiceModelReady(readyOnOtherQuant!), true);
  assert.equal(isVoiceModelDownloading(readyOnOtherQuant!), false);
  assert.equal(isVoiceModelReady(mixed!), true);
  assert.equal(isVoiceModelDownloading(mixed!), true);
});

test("catalog language data matches the model cards for the models users pick for uk/ru/en", () => {
  const byId = new Map(VOICE_MODEL_CATALOG.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("whisper-small")!.languages.length, 99);
  assert.equal(byId.get("whisper-large-v3-turbo")!.languages.length, 100);
  assert.equal(byId.get("whisper-large-v3")!.languages.length, 100);
  assert.equal(byId.get("parakeet-tdt-0.6b-v3")!.languages.length, 25);
  assert.deepEqual(byId.get("parakeet-unified-en-0.6b")!.languages, ["en"]);
  assert.deepEqual([...byId.get("canary-180m-flash")!.languages].sort(), ["de", "en", "es", "fr"]);
  for (const id of ["whisper-small", "parakeet-tdt-0.6b-v3", "canary-1b-v2"]) {
    assert.ok(byId.get(id)!.languages.includes("uk"), `${id} should support Ukrainian`);
    assert.ok(byId.get(id)!.languages.includes("ru"), `${id} should support Russian`);
  }
  assert.deepEqual(byId.get("gigaam-v3-e2e-rnnt")!.languages, ["ru"]);
});

test("the recommendation for Ukrainian dictation is the multilingual Parakeet, English gets the live model", () => {
  assert.equal(recommendVoiceModel(VOICE_MODEL_CATALOG, ["uk"])?.id, "parakeet-tdt-0.6b-v3");
  assert.equal(recommendVoiceModel(VOICE_MODEL_CATALOG, ["en"])?.id, "parakeet-unified-en-0.6b");
  assert.equal(recommendVoiceModel(VOICE_MODEL_CATALOG, ["ja"])?.id, "whisper-large-v3-turbo");
  assert.equal(
    recommendVoiceModel(VOICE_MODEL_CATALOG, ["uk", "ja"])?.id,
    "whisper-large-v3-turbo",
  );
});
