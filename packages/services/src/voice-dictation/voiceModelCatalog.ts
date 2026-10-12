// Speech transcription model catalog. Data comes from src-tauri/src/catalog/catalog.json of
// cjpais/Handy (MIT), including only each model's default quantization (Q8_0). The sha256 values
// are the trust anchors for download verification and must be cross-checked whenever models are updated.

export interface VoiceModelDescriptor {
  id: string;
  name: string;
  description: string;
  family: string;
  languageCount: number;
  streaming: boolean;
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
    languageCount: 99,
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
    languageCount: 99,
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
    languageCount: 99,
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
    languageCount: 100,
    streaming: false,
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
    languageCount: 1,
    streaming: true,
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
    languageCount: 25,
    streaming: false,
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
    languageCount: 4,
    streaming: false,
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
    languageCount: 1,
    streaming: true,
    license: "other",
    huggingFaceRepo: "handy-computer/nemotron-speech-streaming-en-0.6b-gguf",
    revision: "7d9b719206789e4068d87c6398262ab4dfd4e45d",
    fileName: "nemotron-speech-streaming-en-0.6b-Q8_0.gguf",
    sizeBytes: 729650176,
    sha256: "90d8c89714cd31efc88be62a40c6b2bea57e0cc2063af1ffe2c28f1a228ca110",
  },
];

export function findVoiceModelDescriptor(
  id: string,
  catalog: readonly VoiceModelDescriptor[] = VOICE_MODEL_CATALOG,
): VoiceModelDescriptor | undefined {
  return catalog.find((model) => model.id === id);
}
