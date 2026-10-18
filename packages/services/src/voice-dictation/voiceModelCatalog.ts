// Speech transcription model catalog. Data comes from src-tauri/src/catalog/catalog.json of
// cjpais/Handy (MIT), including only each model's default quantization (Q8_0). The sha256 values
// are the trust anchors for download verification and must be cross-checked whenever models are updated.

import {
  EUROPEAN_25_LANGUAGES,
  WHISPER_LANGUAGES,
  WHISPER_V3_LANGUAGES,
} from "./voiceModelLanguageCodes.js";

/** Every locale was accepted by `nemotron-3.5-asr-streaming-0.6b` at stream begin; its native layer rejects bare codes. */
const NEMOTRON_35_LOCALES = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  pt: "pt-BR",
  nl: "nl-NL",
  de: "de-DE",
  tr: "tr-TR",
  ru: "ru-RU",
  ar: "ar-AR",
  hi: "hi-IN",
  ja: "ja-JP",
  ko: "ko-KR",
  vi: "vi-VN",
  uk: "uk-UA",
  pl: "pl-PL",
  sv: "sv-SE",
  cs: "cs-CZ",
  nb: "nb-NO",
  da: "da-DK",
  bg: "bg-BG",
  fi: "fi-FI",
  hr: "hr-HR",
  sk: "sk-SK",
  zh: "zh-CN",
  hu: "hu-HU",
  ro: "ro-RO",
  et: "et-EE",
} as const;

export interface VoiceModelDescriptor {
  id: string;
  name: string;
  description: string;
  family: string;
  /** ISO 639-1 codes the model supports (from the model card; Handy's catalog agrees). */
  languages: readonly string[];
  /**
   * Maps a bare language code to the locale the native layer accepts, for models that reject bare codes
   * (checked against transcribe-cpp 0.3.1; `capabilities.languages` is garbled by the binding, so this is static data).
   */
  languageLocales?: Readonly<Record<string, string>>;
  /** Runtime-verified live streaming: the model loaded, `selectStreamFamily` picked a family, and text arrived while feeding. */
  streaming: boolean;
  /** Lower is recommended first among models covering the selected languages; absent means never recommended. */
  recommendRank?: number;
  license: string;
  huggingFaceRepo: string;
  revision: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export const VOICE_MODEL_CATALOG: readonly VoiceModelDescriptor[] = [
  {
    id: "whisper-tiny",
    name: "Whisper Tiny",
    description: "99 languages, auto language detection, segment timestamps.",
    family: "whisper",
    languages: WHISPER_LANGUAGES,
    streaming: false,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-tiny-gguf",
    revision: "6687f30c99641ee265df421e582354adbc8848fc",
    fileName: "whisper-tiny-Q8_0.gguf",
    sizeBytes: 45981088,
    sha256: "325b9c7997cd1eff81ef709d55766565e71be696130cc3a3d444713798706834",
  },
  {
    id: "whisper-base",
    name: "Whisper Base",
    description: "99 languages, auto language detection, segment timestamps.",
    family: "whisper",
    languages: WHISPER_LANGUAGES,
    streaming: false,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-base-gguf",
    revision: "e0f69524f648720eca44c024d1d0dbb7027d1fa0",
    fileName: "whisper-base-Q8_0.gguf",
    sizeBytes: 84962880,
    sha256: "81c069428bc8a24551a8169cf31cf09bcfd9d4cf50389ae281323c9aa9648c81",
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    description: "99 languages, auto language detection, segment timestamps.",
    family: "whisper",
    languages: WHISPER_LANGUAGES,
    streaming: false,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-small-gguf",
    revision: "c0214bd34be9296695486f838e0142f900803159",
    fileName: "whisper-small-Q8_0.gguf",
    sizeBytes: 269751136,
    sha256: "9b9c8811bbcc82a7766f0fb0925614bdacb0923b2cc630daeac17108b655b860",
  },
  {
    id: "whisper-large-v3-turbo",
    name: "Whisper Large v3 Turbo",
    description: "100 languages, auto language detection, segment timestamps.",
    family: "whisper",
    languages: WHISPER_V3_LANGUAGES,
    streaming: false,
    recommendRank: 4,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-large-v3-turbo-gguf",
    revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
    fileName: "whisper-large-v3-turbo-Q8_0.gguf",
    sizeBytes: 886381760,
    sha256: "b2e30cc286bc9f3aba4db9099fc7403543497c05ce7100d0d83091ddfd25a183",
  },
  {
    id: "parakeet-unified-en-0.6b",
    name: "Parakeet Unified EN 0.6B",
    description: "Fast, accurate live English transcription.",
    family: "parakeet",
    languages: ["en"],
    streaming: true,
    recommendRank: 1,
    license: "cc-by-4.0",
    huggingFaceRepo: "handy-computer/parakeet-unified-en-0.6b-gguf",
    revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
    fileName: "parakeet-unified-en-0.6b-Q8_0.gguf",
    sizeBytes: 731357568,
    sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    name: "Parakeet TDT 0.6B v3",
    description: "Fast and accurate. Supports 25 European languages.",
    family: "parakeet",
    languages: EUROPEAN_25_LANGUAGES,
    streaming: false,
    recommendRank: 2,
    license: "cc-by-4.0",
    huggingFaceRepo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
    revision: "85ac09ea12fc4b1112fa76810059364bc6adc9de",
    fileName: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
    sizeBytes: 739508576,
    sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
  },
  {
    id: "canary-180m-flash",
    name: "Canary 180M Flash",
    description: "Tiny and instant, runs well on any hardware.",
    family: "canary",
    languages: ["en", "de", "es", "fr"],
    streaming: false,
    recommendRank: 3,
    license: "cc-by-4.0",
    huggingFaceRepo: "handy-computer/canary-180m-flash-gguf",
    revision: "b147f9dc52b59f0998e410540a84727bd86457fd",
    fileName: "canary-180m-flash-Q8_0.gguf",
    sizeBytes: 218447552,
    sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
  },
  {
    id: "nemotron-speech-streaming-en-0.6b",
    name: "Nemotron Speech Streaming EN",
    description: "English speech-to-text with streaming and token-level timestamps.",
    family: "nemotron",
    languages: ["en"],
    streaming: true,
    license: "other",
    huggingFaceRepo: "handy-computer/nemotron-speech-streaming-en-0.6b-gguf",
    revision: "7d9b719206789e4068d87c6398262ab4dfd4e45d",
    fileName: "nemotron-speech-streaming-en-0.6b-Q8_0.gguf",
    sizeBytes: 729650176,
    sha256: "90d8c89714cd31efc88be62a40c6b2bea57e0cc2063af1ffe2c28f1a228ca110",
  },
  {
    id: "nemotron-3.5-asr-streaming-0.6b",
    name: "Nemotron Streaming 3.5",
    description: "Live multilingual transcription across 28 languages.",
    family: "nemotron",
    languages: Object.keys(NEMOTRON_35_LOCALES),
    languageLocales: NEMOTRON_35_LOCALES,
    streaming: true,
    license: "other",
    huggingFaceRepo: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
    revision: "6d44e540bc31b0de1dbe174a3cea87f53a7f22fb",
    fileName: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
    sizeBytes: 751094240,
    sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
  },
  {
    id: "whisper-medium",
    name: "Whisper Medium",
    description:
      "Broadest language coverage; a good accuracy/speed balance, though slower than Small.",
    family: "whisper",
    languages: WHISPER_LANGUAGES,
    streaming: false,
    recommendRank: 5,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-medium-gguf",
    revision: "ec78f06fded51aa82cde751678b78f76f78c8b7f",
    fileName: "whisper-medium-Q8_0.gguf",
    sizeBytes: 831538144,
    sha256: "09e6a65e7de377aa5b10bae24608bc6f8ca2ed04b3993ef10d4a02bcd9a82adf",
  },
  {
    id: "whisper-large-v3",
    name: "Whisper Large v3",
    description:
      "100 languages, auto language detection, segment timestamps. Most accurate Whisper, needs a fast machine.",
    family: "whisper",
    languages: WHISPER_V3_LANGUAGES,
    streaming: false,
    license: "apache-2.0",
    huggingFaceRepo: "handy-computer/whisper-large-v3-gguf",
    revision: "e3e29bee6389c7da4a141406f07bb80ddac5337c",
    fileName: "whisper-large-v3-Q8_0.gguf",
    sizeBytes: 1668741440,
    sha256: "2fa1a5f179f8a511a53e2108db270aa4af3ce08cd976af4180e2854666bb4ba3",
  },
  {
    id: "canary-1b-v2",
    name: "Canary 1B v2",
    description: "Accurate 25-language speech-to-text with translation.",
    family: "canary",
    languages: EUROPEAN_25_LANGUAGES,
    streaming: false,
    license: "cc-by-4.0",
    huggingFaceRepo: "handy-computer/canary-1b-v2-gguf",
    revision: "58d13c2c0102229aad45f7e19a77ddc42b41dd9a",
    fileName: "canary-1b-v2-Q8_0.gguf",
    sizeBytes: 1144290016,
    sha256: "224f83d1bc487b3303b495a7d6874912fdece93de19d1a04b550829c30a5d289",
  },
  {
    id: "gigaam-v3-e2e-rnnt",
    name: "GigaAM v3 E2E RNN-T",
    description: "Compact, fast Russian-only speech-to-text.",
    family: "gigaam",
    languages: ["ru"],
    streaming: false,
    license: "mit",
    huggingFaceRepo: "handy-computer/gigaam-v3-e2e-rnnt-gguf",
    revision: "f719d70812344f4d0fb8c11c0887b190501a7465",
    fileName: "gigaam-v3-e2e-rnnt-Q8_0.gguf",
    sizeBytes: 273724832,
    sha256: "78d63b47723b7f8d78c6113a6ef983b5a86e2a86f6c273e1f5cb6967b1c4467a",
  },
];

export function findVoiceModelDescriptor(
  id: string,
  catalog: readonly VoiceModelDescriptor[] = VOICE_MODEL_CATALOG,
): VoiceModelDescriptor | undefined {
  return catalog.find((model) => model.id === id);
}
