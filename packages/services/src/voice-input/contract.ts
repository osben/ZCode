import { ServiceChannels } from "@zcode/shared";
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 语音输入失败原因（docs/chat/composer-voice-input.md「服务端失败」）。
 * UI 只按这里的分类给提示，不感知 zcode-server 的原始错误码。
 */
export type VoiceInputErrorCode =
  | "network"
  /** 经 HTTP 代理时，WS 在 started 前非正常关闭：服务端的 error / close 帧没有到达客户端 */
  | "proxy"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "upstream_timeout"
  | "audio_limit_exceeded"
  | "audio_too_short"
  | "failed"
  /** Fork: no local dictation model selected (or not downloaded) — offer the voice settings page. */
  | "no_model";

export type VoiceInputEvent =
  | { attemptId: string; type: "started" }
  /** text 是本次识别的完整快照，替换上一条，不追加 */
  | { attemptId: string; type: "result"; text: string }
  | { attemptId: string; type: "completed"; text: string }
  | { attemptId: string; type: "error"; code: VoiceInputErrorCode };

/**
 * 桌面本机 Host 的语音输入服务：申请 ASR ticket 并通过 WebSocket 转发 PCM16 音频。
 * 同一时间只有一个会话；新的 start 会取消上一个。只在桌面 base 连接注册给 renderer。
 */
export interface IVoiceInputService {
  readonly onEvent: Event<VoiceInputEvent>;
  /**
   * 立即返回；连接结果通过 onEvent 的 started / error 通知。
   * Fork: 本地 whisper 引擎时 language 是 fork 设置解析出的单码（或 "auto"），
   * model 携带 voiceDictation 设置的 modelId 与可选 quant；云端引擎忽略两者。
   */
  start(params: {
    attemptId: string;
    language: string;
    model?: { modelId: string; quant?: string };
  }): Promise<void>;
  /** 16kHz 单声道 PCM16LE；started 之前到达的音频按顺序缓存 */
  sendAudio(params: { attemptId: string; chunk: Uint8Array }): Promise<void>;
  /** 结束录音，等待 completed；model 与 start 一致（本地 one-shot 路径在 finish 时才转录）。 */
  finish(params: { attemptId: string; model?: { modelId: string; quant?: string } }): Promise<void>;
  /** 取消识别，不再发出该 attempt 的事件 */
  cancel(params: { attemptId: string }): Promise<void>;
}

export const IVoiceInputService = createServiceDescriptor<IVoiceInputService>(
  ServiceChannels.VoiceInput,
);
