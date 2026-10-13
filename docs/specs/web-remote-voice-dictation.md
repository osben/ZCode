# Web 远程语音听写（Web Speech API）

## 目标与范围

Web 远程控制客户端（浏览器中的 remote control 页面）的聊天输入框增加麦克风听写入口：通过标准 Web Speech API（`SpeechRecognition` / `webkitSpeechRecognition`）在浏览器内完成采集与转写，转写文本走与桌面端相同的 `onTranscript` 插入链路写入 Composer。桌面端 Host whisper 链路（`useVoiceDictation` + `IVoiceDictationService` + 16kHz PCM 录音）保持不变，不共用任何录音/转写代码。

```mermaid
sequenceDiagram
    participant U as 用户（Web 远程）
    participant C as Composer（V4ComposerVoiceButton）
    participant H as useWebSpeechDictation
    participant E as WebSpeechDictationEngine
    participant B as 浏览器 SpeechRecognition
    U->>C: 点击麦克风
    C->>H: toggle()
    H->>E: start({language, 回调})
    E->>B: new SpeechRecognition(); start()
    B-->>E: start 事件
    E-->>H: onSessionStart（phase → recording）
    B-->>E: result（interim / final）
    E-->>H: onPreview（复用 VoiceTranscriptionPreview 预览）
    U->>C: 再次点击停止
    C->>H: toggle()
    H->>E: stop()
    B-->>E: end 事件
    E-->>H: onSessionEnd(累计 final 文本)
    H->>C: onTranscript(text)（appendText 插入输入框）
    B-->>E: error（not-allowed / network / …）
    E-->>H: onError(code)
    H-->>U: toast（权限失败 / 转写失败）
```

## 引擎选择矩阵

| 环境                                                    | 采集与转写                                                          | 入口可见性                     |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| 桌面端（Electron）                                      | Host whisper：`useVoiceDictation`（快捷键、推说话、16kHz PCM 流式） | 一直可见（现状不变）           |
| Web 远程 + SpeechRecognition 可用（Chrome/Edge/Safari） | 浏览器 Web Speech API：`useWebSpeechDictation`                      | 可见                           |
| Web 远程 + API 缺失（Firefox 等）                       | 无                                                                  | 隐藏（不是禁用态，避免死按钮） |
| 普通浏览器直连 Web（非远程控制）                        | 无                                                                  | 隐藏（现状不变）               |

引擎必须可插拔：两个 hook 对 UI 暴露同一控制面（`phase / level / preview / start / stop / toggle`），`VoiceDictationComposerControl` 按运行模式选择引擎；未来通过 relay 接入 host-whisper 的新引擎只需实现同一控制面并在此处接入，按钮与插入链路零改动。

## 隐私说明（第一版接受的边界）

Chrome/Edge 的 SpeechRecognition 识别在云端完成（音频交由 Google 服务器处理）；Safari 经 Apple 基础设施处理。即音频不出本机麦克风但出本机浏览器，交由平台厂商处理。第一版接受该权衡；隐私保守的替代方案是后续规划的 host-whisper 引擎：音频经现有 relay 送往桌面 Host 的 `IVoiceDictationService`（要求 16kHz 单声道 PCM16 小端，见 `packages/services/src/voice-dictation/voiceDictation.ts`），实现同一 `onTranscript` 契约后即可替换 UI 分支。

## 行为契约

- 状态所有者：会话状态（phase/preview/最终文本）只在 `useWebSpeechDictation` hook 内；引擎实例只服务一次会话生命周期，`endDelivered` 保证 `onSessionEnd` 每会话至多派发一次。UI 不持有听写状态。
- 启动：`continuous = true`、`interimResults = true`、`maxAlternatives = 1`；`lang` 取 `settings.voiceDictation.language`（`auto`/缺失时留空，用浏览器默认）；Web 端不读取 modelId / 输入设备 / 空闲卸载等桌面偏好。
- 预览：interim 结果映射为 `{ committed, tentative }`（复用 `VoiceTranscriptionPreview` 形状与现有按钮预览 UI）；committed 为已 final 的累计文本。
- 插入：用户停止（或浏览器因静音自动结束）时，累计的 final 文本 trim 后经 `onTranscript` 一次性插入；空文本不插入。与桌面端一致：插入动作由 Composer 的 `insertVoiceTranscript`（appendText + focus）完成。
- 幂等：`start`/`stop`/`toggle` 在重复调用、非 idle 相位调用时为无操作；引擎在已监听时忽略再次 start，未监听时 stop 为无操作。
- 错误处理（不静默）：`not-allowed` / `service-not-allowed` / `audio-capture` → toast `voiceDictation.microphoneFailed`；`network` / `language-not-supported` 等其他错误 → toast `voiceDictation.transcribeFailed`；均经 `packages/ui/src/logger.ts` warn 记录。`no-speech`（静音自动结束）与 `aborted`（stop/abort 伴随事件，final 文本仍经 onSessionEnd 送达）按桌面端短录音静默语义处理：仅 info 日志，不 toast。start 抛出的同步异常按转写失败处理，不停留在 loading。
- 卸载/取消：组件卸载时 abort，不插入文本、不写状态（与桌面端 finalize 期间卸载不插入的语义一致）。
- 覆盖桌面端检查：`enabled: !webRemote` 使桌面分支在 Web 远程下完全不激活；桌面端调用参数与现状逐字节一致。
- 可访问性：复用现有按钮（aria-label / aria-pressed / live region）；Web 引擎无音频电平，level 恒为 0，电平条显示为最小基线。
- 设置页 `VoiceDictationSection` 保持桌面端专属（Web 远程仍显示 "Desktop only" 徽章），本版不新增任何设置项。

## 验收场景

1. Firefox（无 API）打开 Web 远程控制：输入框无麦克风入口；Chrome 打开：入口可见。
2. Chrome 点击麦克风 → 说话 → interim 文本出现在预览 → 再点停止 → final 文本一次性插入输入框光标处。
3. 拒绝麦克风权限（`not-allowed`）：toast 提示麦克风失败，UI 回到 idle；`network` 错误同理提示转写失败。
4. 快速连点麦克风 / 重复调用 start、stop：无异常、无重复插入。
5. 桌面端（Electron）：行为与改动前完全一致（现有 `useVoiceDictation` 测试全绿），Web API 存在与否不影响桌面分支。
6. 静音不说话直到浏览器自动结束：无 toast、无插入，仅 info 日志。

## 验证

- `packages/ui/test/useWebSpeechDictation.test.ts`（jsdom + mock SpeechRecognition）覆盖上述 1、2、3、4、5 的 hook/组件级场景。
- `pnpm typecheck`、`pnpm lint`、`npx oxfmt --check <changed files>`、`pnpm architecture:check --changed`。
- 真实麦克风与各浏览器实测无法在 CI/worktree 中执行，在 PR "Not verified" 中列出手动步骤。
