# desktop-microphone-access

Composer 语音输入（`docs/chat/composer-voice-input.md`）在 Main 进程的系统权限部分：检查 / 请求麦克风系统权限，打开系统设置页。

不变量：

- 只打开本模块列出的固定系统设置地址；renderer 只能选择 `privacy` 或 `sound`，不能传 URL。
- macOS `not-determined` 时才调用 `askForMediaAccess`；Windows 无法判定时返回 `unsupported`，交给 `getUserMedia` 的真实结果。
- Linux 没有统一的系统设置地址，`openSettings` 返回 `false`。
- `ResetMicrophoneAccess`（仅 macOS）：已授权直接返回 `granted`；受限返回 `failed`；打包版先用 `/usr/bin/tccutil reset Microphone <bundleId>` 清除本应用的 TCC 记录，bundle id 从可执行文件所在 `Contents/Info.plist` 读取并校验字符集；开发版不执行 tccutil。之后重新读取状态：`granted` → `granted`，`not-determined` → 请求授权，其余 → `restart-required`。
- 并发的重置请求共用同一个 Promise，tccutil 不会对同一条 TCC 记录重复执行。
