/**
 * voice-input（UI）对外契约：Composer 只依赖这里的类型与 index.ts 导出的 hook / 组件。
 */
export type VoiceInputState = "idle" | "requesting" | "recording" | "finishing";

/** Composer 触发的结束原因：发送消息、用户修改输入框。两者都与点击停止一致，等待最终结果。 */
export type VoiceInputStopReason = "submit" | "user-input";

/** 权限引导弹层的阶段：denied 需要到系统设置或重新授权；restart-required 需要重启应用后再请求。null 表示不显示。 */
export type VoicePermissionPhase = "denied" | "restart-required";

/** 麦克风权限引导状态（docs/chat/composer-voice-input.md「麦克风权限」）。 */
export interface VoicePermissionGuide {
  phase: VoicePermissionPhase | null;
  /** 弹层文案按系统区分；linux 不提供引导（available 为 false） */
  os: "mac" | "windows";
  available: boolean;
  /** 「重新授权」进行中 */
  busy: boolean;
  /** 权限被拒绝时显示引导（phase = denied） */
  show: () => void;
  close: () => void;
  openSettings: () => void;
  /** 清除旧授权并重新请求；结果为 granted 时关闭引导并提示成功 */
  reauthorize: () => Promise<void>;
  /** 重启应用（restart-required 阶段） */
  relaunch: () => void;
}

export interface ComposerVoiceInput {
  /** 当前环境可用（桌面、已登录、Host 提供服务） */
  available: boolean;
  state: VoiceInputState;
  toggle: () => void;
  /**
   * 与点击停止一致地结束当前识别：发送尾块和 finish，等待最终结果替换语音文字。
   * 返回的 Promise 在本次识别结束（完成、失败或取消）时 resolve；空闲时返回 undefined，调用方无需等待。
   * 等待可能跨越会话切换：恢复后调用方必须自行校验目标是否仍有效。
   */
  settle: (reason: VoiceInputStopReason) => Promise<void> | undefined;
  /** 订阅录音中每个 100ms 音频块的峰值电平（满量程 1）；返回取消订阅函数。引用稳定 */
  subscribeLevel: (listener: (peak: number) => void) => () => void;
  /** 麦克风系统权限被拒绝时的引导弹层状态 */
  permissionGuide: VoicePermissionGuide;
}
