/* eslint-disable max-lines -- Bot 文案按 zh-CN/en-US/uk-UA 三语言成套维护，行数随语言数增长属预期。 */
import type { Locale } from "@zcode/shared";

export type BotMessageLocale = Locale;

type MessageValues = Record<string, string | number | undefined>;

const DEFAULT_BOT_MESSAGE_LOCALE: BotMessageLocale = "zh-CN";

const messages = {
  "zh-CN": {
    botDisabled: "当前 bot 未启用。",
    groupOwnerOnly: "仅绑定机器人的用户可以执行此操作。",
    groupNotEnabled: "此群尚未启用，请绑定用户 @机器人 /enable。",
    groupEnabled:
      "群聊已启用。话题历史默认开启，同一工作区的文件共享，可能发生并发修改。\n\n使用话题前，请应用管理员确认已开通相关权限：\n1. 打开[开放平台后台]({permissionsUrl})，选择当前机器人应用。\n2. 在权限管理中开通应用身份的消息读取权限，包括 `im:message.group_msg`（获取用户群消息）。接收其他机器人的 @ 还需 `im:message.group_at_msg.include_bot:readonly`；若需接收话题内未 @ 的机器人消息，开通 `im:message.group_msg.include_bot:read`。\n3. 可选：开通 `im:chat.members:read`（查看群成员），用于显示发送者用户名；缺少此权限不影响任务执行。\n4. 发布生效后，在话题内 @机器人提交需求。\n\n群启用不代表应用权限已开通；缺少话题历史读取权限时不会执行话题任务。",
    groupDisabled: "群聊已停用。已接收的任务保留在 Desktop。",
    privateChatOnly: "Bots 暂不支持群聊，请在私聊中使用。",
    bindPrivateOnly: "Bots 只允许在私聊中绑定。",
    userNotBound: "当前 bot 未绑定。请先在 zcode UI 生成绑定码，然后发送 **/bind <code>**。",
    commandNotAllowed: "当前 bot 未启用这个命令。",
    noWorkspaceAllowed: "没有可用 workspace，请先在 Bots 设置里允许 workspace。",
    workspaceOutOfScope: "当前聊天上下文的 workspace 已不在授权范围内，请重新选择 **/项目**。",
    bindCodeInvalid: "绑定码无效或已过期，请在 zcode UI 重新生成。",
    bindBotMissing: "绑定失败：bot 不存在。",
    bindSuccess: "绑定成功。发送 **/帮助** 查看可用命令。",
    weixinActivatedWelcome: "微信 Bot 已激活。发送 **/帮助** 查看命令，或直接描述你要做的事。",
    helpTitle: "ZCode 机器人命令：",
    helpHelp: "**/帮助** — 查看这份说明",
    helpBind: "**/bind <code>** — 绑定当前聊天",
    helpStatus: "**/状态** — 查看工作区、模型和任务状态",
    helpNew: "/新建 或 /clear — 开始新的任务草稿",
    helpWorkspace: "**/项目** — 切换工作区",
    helpModel: "**/模型** — 切换模型",
    helpMode: "**/模式** — 切换运行模式",
    helpThoughtLevel: "**/思考** — 切换思考级别",
    helpReply: "**/回复** — 切换回复详细程度",
    webhookSecretInvalid: "Webhook secret 校验失败。",
    // Bugfix: 这条错误由通用 provider callback 处理路径触发，微信/飞书失败时不能误显示 Telegram。
    callbackFailed: "处理机器人回调失败：{message}",
    sessionExpiredNewTaskHint:
      "当前任务会话已失效，可能是任务已被清理或机器人消息已过期。请发送 **/new task** 创建新任务后再继续。",
    deletedTaskReplaced:
      "原任务已删除，已为你新建任务。本条消息将在新任务中处理，不会继承原任务的对话上下文。",
    received: "已收到。",
    attachmentOnlyPrompt: "请查看附件并根据内容协助我。",
    attachmentRejected: "附件处理失败：{message}",
    attachmentDownloadUnavailable:
      "无法下载附件。文件可能已过期、已撤回，或机器人没有读取权限。请重新发送附件后再试。",
    attachmentTooLarge: "附件超过 5MB，请压缩后重新发送。",
    selectionCancelled: "已取消。",
    selectionCancelOption: "取消",
    selectionTextHint: "回复数字选择，0 取消。",
    selectionTextHintNoCancel: "回复数字选择。",
    newTaskDraft: "已进入 {workspacePath} 的新任务草稿。",
    workspaceSelectTitle: "当前 workspace {workspace}\n选择 workspace",
    workspaceMissing: "未找到可用 workspace。",
    modelSelectTitle: "选择 model",
    modelProviderSelectTitle: "当前模型 {model}\n选择模型供应商",
    modelModelSelectTitle: "当前模型 {model}\n选择模型",
    modelMissing: "未找到 model。",
    sessionModelUnavailable: "当前会话的模型选择不可用，请使用 /model 重新选择。原选择已保留。",
    modeSelectTitle: "当前模式 {mode}\n选择模式",
    modeMissing: "未找到模式。",
    modeChanged: "当前任务模式已切换为 {mode}。",
    modeLocked: "机器人已锁定 **yolo** 运行模式，无法切换。",
    thoughtLevelSelectTitle: "当前思考级别 {level}\n选择思考级别",
    thoughtLevelMissing: "当前模型不支持思考级别。",
    thoughtLevelChanged: "当前任务思考级别已切换为 {level}。",
    modelProviderMissing: "未找到模型供应商。",
    modelChanged: "当前任务 model 已切换为 {model}。",
    taskMissing: "未找到任务。",
    taskChanged: "已切换到任务：{title}",
    noActiveTask: "当前没有 active task。",
    permissionExpired: "权限请求已过期，请在 zcode UI 中处理。",
    permissionHandled: "权限请求已处理。",
    permissionDenied: "已拒绝权限请求。",
    permissionSubmitted: "已提交权限响应。",
    elicitationExpired: "问答请求已过期，请在 zcode UI 中处理。",
    elicitationHandled: "问答请求已处理。",
    elicitationSubmitted: "已提交问答响应。",
    elicitationCancelled: "已取消问答请求。",
    elicitationCustomOption: "自定义回答",
    elicitationCustomPlaceholder: "请输入自定义回答",
    elicitationQuestionTitle: "提问",
    planApprovalTitle: "请审阅此实施计划。",
    planApprovalHeader: "实施计划",
    planApprovalApprove: "批准",
    planApprovalApproveDescription: "退出计划模式并开始实施。",
    elicitationCancelledCard: "✅ 问答已取消",
    elicitationSubmitOption: "完成",
    elicitationSkipOption: "跳过",
    elicitationMultiSelectHint: "可多选；再次选择会取消，选择“完成”提交。",
    elicitationTextHint: "也可以直接回复文本作为自定义答案。",
    statusWorkspace: "工作区",
    statusModel: "模型",
    statusTask: "任务",
    statusState: "状态",
    statusWorked: "已工作",
    statusProgress: "进展",
    statusDraft: "草稿",
    statusRemoteDisconnected: "远端未连接",
    statusCancelled: "已取消",
    statusStopped: "已停止",
    streamingStatusRunning: "⏳ 运行中",
    streamingStatusCompleted: "✅ 已完成",
    streamingStatusFailed: "失败",
    streamingWorking: "正在处理...",
    streamingToolSummaries: "工具摘要",
    stopSubmitted: "已停止当前任务生成。",
    unknownCommand: "未知命令：**/{command}**",
    taskFailed: "任务失败：{message}",
    groupTaskQueued:
      "当前任务还有排队输入（可能已暂停）。请在 Desktop 处理或移除队列后再切换任务；/停止 不会清空队列。",
    groupTaskInteraction: "当前任务正在等待回答或审批。请先处理该交互，或使用 /停止 结束当前任务。",
    groupTaskDisconnected: "远程工作区已断开，无法确认当前任务状态。请先使用 /reconnect 重连。",
    taskRunning: "当前任务正在运行，稍后再试，或使用 **/停止** 停止当前任务。",
    taskSelectTitle: "当前任务 {task}\n选择任务",
    noHistoryTasks: "当前 workspace 没有历史任务。",
    remoteDisconnected:
      "当前远端项目 {workspacePath} 未连接。请先发送 **/重连**，连接恢复后再重试。上一条请求未执行。",
    remoteDisconnectedStatus: "当前远端项目 {workspacePath} 未连接。请发送 **/重连** 恢复连接。",
    remoteWorkspaceSelectedDisconnected:
      "已切换到远端项目 {workspacePath}，但当前未连接。请先发送 **/重连** 后再执行任务。",
    remoteReconnectStarting: "当前远端项目 {workspacePath} 未连接，正在为你重连...",
    remoteReconnectFailed: "当前远端项目 {workspacePath} 重连失败：{message}\n上一条请求没有执行。",
    remoteReconnectUnavailable:
      "当前远端项目 {workspacePath} 未连接，但机器人无法访问远端重连服务。请先在 ZCode 打开该远端项目后重试。",
    remoteReconnectLocal: "当前 workspace 是本地项目，不需要重连。发送 **/项目** 可切换远端项目。",
    remoteReconnectAlreadyConnected: "当前远端项目 {workspacePath} 已连接。",
    replySelectTitle: "当前第三方回复颗粒度 {mode}\n选择第三方回复颗粒度",
    replyMissing: "未找到回复颗粒度。",
    replyChanged: "第三方回复颗粒度已切换为 {mode}。",
  },
  "en-US": {
    botDisabled: "This bot is not enabled.",
    groupOwnerOnly: "Only the bound bot owner can perform this action.",
    groupNotEnabled:
      "This group is not enabled. Ask the bound owner to mention the bot with /enable.",
    groupEnabled:
      "Group enabled. Topic history defaults on. Workspace files are shared and may be edited concurrently.\n\nBefore using topics, ask the app administrator to confirm the required permissions:\n1. Open the [developer console]({permissionsUrl}) and select this bot app.\n2. In permission management, enable application-identity message read permissions, including `im:message.group_msg` (read user group messages). To receive mentions from other bots, also enable `im:message.group_at_msg.include_bot:readonly`; for bot messages without mentions in topics, enable `im:message.group_msg.include_bot:read`.\n3. Optional: enable `im:chat.members:read` (view group members) to display sender names. Missing this permission does not block task execution.\n4. Publish the changes, then mention the bot in a topic.\n\nEnabling the group does not grant app permissions; topic tasks will not execute without topic history read permissions.",
    groupDisabled: "Group disabled. Accepted work remains in Desktop.",
    privateChatOnly: "Bots do not support group chats yet. Please use a private chat.",
    bindPrivateOnly: "Bots can only bind in a private chat.",
    userNotBound:
      "This bot is not bound. Generate a bind code in the zcode UI, then send **/bind <code>**.",
    commandNotAllowed: "This command is disabled for the current bot.",
    noWorkspaceAllowed: "No workspace is available. Allow a workspace in Bots settings first.",
    workspaceOutOfScope:
      "The workspace in this chat is no longer authorized. Please select **/workspace** again.",
    bindCodeInvalid: "The bind code is invalid or expired. Generate a new one in the zcode UI.",
    bindBotMissing: "Bind failed: bot does not exist.",
    bindSuccess: "Bound successfully. Send **/help** to see available commands.",
    weixinActivatedWelcome:
      "Weixin bot is active. Send **/help** to see commands, or describe what you want to do.",
    helpTitle: "ZCode bot commands:",
    helpHelp: "**/help** — Show this guide",
    helpBind: "**/bind <code>** — Bind this chat",
    helpStatus: "**/status** — Show workspace, model, and task status",
    helpNew: "/new or /clear — Start a new task draft",
    helpWorkspace: "**/project** — Switch workspace",
    helpModel: "**/model** — Switch model",
    helpMode: "**/mode** — Switch run mode",
    helpThoughtLevel: "**/think** — Switch thought level",
    helpReply: "**/reply** — Switch reply detail",
    webhookSecretInvalid: "Webhook secret verification failed.",
    callbackFailed: "Failed to process bot callback: {message}",
    sessionExpiredNewTaskHint:
      "The current task session has expired. It may have been cleaned up, or this bot message is stale. Send **/new task** to create a new task and continue.",
    deletedTaskReplaced:
      "The previous task was deleted, so I created a new task for you. This message will be processed in the new task without the previous conversation history.",
    received: "Received.",
    attachmentOnlyPrompt: "Please review the attachment and help based on its content.",
    attachmentRejected: "Failed to process attachment: {message}",
    attachmentDownloadUnavailable:
      "Could not download the attachment. The file may have expired, been removed, or the bot may not have permission to read it. Please send the attachment again and try once more.",
    attachmentTooLarge: "The attachment exceeds 5MB. Compress it and send it again.",
    selectionCancelled: "Cancelled.",
    selectionCancelOption: "Cancel",
    selectionTextHint: "Reply with a number to choose, or 0 to cancel.",
    selectionTextHintNoCancel: "Reply with a number to choose.",
    newTaskDraft: "Entered a new task draft in {workspacePath}.",
    workspaceSelectTitle: "Current workspace {workspace}\nSelect workspace",
    workspaceMissing: "No available workspace found.",
    modelSelectTitle: "Select model",
    modelProviderSelectTitle: "Current model {model}\nSelect model provider",
    modelModelSelectTitle: "Current model {model}\nSelect model",
    modelMissing: "Model not found.",
    sessionModelUnavailable:
      "The session's model selection is unavailable. Use /model to choose again. Your saved selection has been preserved.",
    modeSelectTitle: "Current mode {mode}\nSelect mode",
    modeMissing: "Mode option not found.",
    modeChanged: "Current task mode changed to {mode}.",
    modeLocked: "This bot is locked to **yolo** run mode and cannot be switched.",
    thoughtLevelSelectTitle: "Current thought level {level}\nSelect thought level",
    thoughtLevelMissing: "The current model does not support thought level.",
    thoughtLevelChanged: "Current task thought level changed to {level}.",
    modelProviderMissing: "Model provider not found.",
    modelChanged: "Current task model changed to {model}.",
    taskMissing: "Task not found.",
    taskChanged: "Switched to task: {title}",
    noActiveTask: "There is no active task.",
    permissionExpired: "This permission request has expired. Please handle it in the zcode UI.",
    permissionHandled: "Permission request has already been handled.",
    permissionDenied: "Permission request denied.",
    permissionSubmitted: "Permission response submitted.",
    elicitationExpired: "This question request has expired. Please handle it in the zcode UI.",
    elicitationHandled: "Question request has already been handled.",
    elicitationSubmitted: "Question response submitted.",
    elicitationCancelled: "Question request cancelled.",
    elicitationCustomOption: "Custom answer",
    elicitationCustomPlaceholder: "Enter a custom answer",
    elicitationQuestionTitle: "Question",
    planApprovalTitle: "Review this implementation plan.",
    planApprovalHeader: "Implementation plan",
    planApprovalApprove: "Approve",
    planApprovalApproveDescription: "Exit plan mode and start implementation.",
    elicitationCancelledCard: "✅ Questions cancelled",
    elicitationSubmitOption: "Done",
    elicitationSkipOption: "Skip",
    elicitationMultiSelectHint:
      "You can select multiple options; select again to remove, then choose Done.",
    elicitationTextHint: "You can also reply with text as a custom answer.",
    statusWorkspace: "Workspace",
    statusModel: "Model",
    statusTask: "Task",
    statusState: "State",
    statusWorked: "Worked",
    statusProgress: "Progress",
    statusDraft: "draft",
    statusRemoteDisconnected: "remote disconnected",
    statusCancelled: "cancelled",
    statusStopped: "stopped",
    streamingStatusRunning: "Running",
    streamingStatusCompleted: "Completed",
    streamingStatusFailed: "Failed",
    streamingWorking: "Working...",
    streamingToolSummaries: "Tool summaries",
    stopSubmitted: "Current task generation stopped.",
    unknownCommand: "Unknown command: **/{command}**",
    taskFailed: "Task failed: {message}",
    groupTaskQueued:
      "The current task still has queued inputs, possibly paused. Process or remove them in Desktop before switching tasks; /stop does not clear the queue.",
    groupTaskInteraction:
      "The current task is waiting for an answer or approval. Resolve it first, or use /stop to stop the task.",
    groupTaskDisconnected:
      "The remote workspace is disconnected. Use /reconnect before checking the current task state.",
    taskRunning:
      "The current task is still running. Try again later, or use **/stop** to stop the current task.",
    taskSelectTitle: "Current task {task}\nSelect task",
    noHistoryTasks: "There are no history tasks in the current workspace.",
    remoteDisconnected:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** first, then try again. The previous request was not executed.",
    remoteDisconnectedStatus:
      "The remote workspace {workspacePath} is not connected. Send **/reconnect** to restore the connection.",
    remoteWorkspaceSelectedDisconnected:
      "Switched to {workspacePath}, but the remote workspace is not connected. Send **/reconnect** before running tasks.",
    remoteReconnectStarting:
      "The remote workspace {workspacePath} is not connected. Reconnecting now...",
    remoteReconnectFailed:
      "Remote workspace {workspacePath} reconnect failed: {message}\nThe previous request was not executed.",
    remoteReconnectUnavailable:
      "The remote workspace {workspacePath} is not connected, but the bot cannot access the remote reconnect service. Open this remote project in ZCode and try again.",
    remoteReconnectLocal:
      "The current workspace is local and does not need reconnecting. Send **/workspace** to switch to a remote project.",
    remoteReconnectAlreadyConnected: "The remote workspace {workspacePath} is connected.",
    replySelectTitle: "Current third-party reply detail {mode}\nSelect third-party reply detail",
    replyMissing: "Reply detail option not found.",
    replyChanged: "Third-party reply detail changed to {mode}.",
  },
  "uk-UA": {
    botDisabled: "Цього бота не ввімкнено.",
    groupOwnerOnly: "Цю дію може виконати лише користувач, який прив'язав бота.",
    groupNotEnabled:
      "Цю групу ще не ввімкнено. Прив'язаний користувач має надіслати @бот /enable.",
    groupEnabled:
      "Груповий чат увімкнено. Історію тем типово відкрито; файли одного робочого простору спільні, можливі паралельні зміни.\n\nПеред використанням тем попросіть адміністратора підтвердити дозволи на платформі ({permissionsUrl}).\n1. Відкрийте [консоль платформи]({permissionsUrl}) і виберіть застосунок цього бота.\n2. У розділі дозволів відкрийте дозволи на читання повідомлень від імені застосунку, зокрема `im:message.group_msg` (читання групових повідомлень користувачів). Для отримання @ від інших ботів потрібен також `im:message.group_at_msg.include_bot:readonly`; для повідомлень бота в темах без @ — `im:message.group_msg.include_bot:read`.\n3. Необов'язково: `im:chat.members:read` (перегляд учасників) для показу імені відправника; без нього завдання все одно виконуватимуться.\n4. Після публікації надішліть @бота в темі з описом потреби.\n\nУвімкнення групи не означає, що дозволи застосунку вже видано; без дозволу на читання історії тем групові завдання не виконуватимуться.",
    groupDisabled:
      "Груповий чат вимкнено. Отримані завдання збережено в Desktop.",
    privateChatOnly: "Боти поки не підтримують групові чати. Скористайтеся приватним чатом.",
    bindPrivateOnly: "Прив'язати бота можна лише в приватному чаті.",
    userNotBound:
      "Цей бот не прив'язаний. Згенеруйте код прив'язки в інтерфейсі zcode, а потім надішліть **/bind <code>**.",
    commandNotAllowed: "Цю команду вимкнено для поточного бота.",
    noWorkspaceAllowed:
      "Немає доступного робочого простору. Спершу дозвольте робочий простір у налаштуваннях ботів.",
    workspaceOutOfScope:
      "Робочий простір у цьому чаті більше не дозволено. Виберіть **/workspace** ще раз.",
    bindCodeInvalid:
      "Код прив'язки недійсний або прострочений. Згенеруйте новий код в інтерфейсі zcode.",
    bindBotMissing: "Не вдалося прив'язати: бота не існує.",
    bindSuccess: "Прив'язку виконано. Надішліть **/help**, щоб переглянути доступні команди.",
    weixinActivatedWelcome:
      "Бот Weixin активний. Надішліть **/help**, щоб переглянути команди, або опишіть, що потрібно зробити.",
    helpTitle: "Команди бота ZCode:",
    helpHelp: "**/help** — показати цю довідку",
    helpBind: "**/bind <code>** — прив'язати цей чат",
    helpStatus: "**/status** — показати стан робочого простору, моделі й завдання",
    helpNew: "/new або /clear — почати чернетку нового завдання",
    helpWorkspace: "**/project** — змінити робочий простір",
    helpModel: "**/model** — змінити модель",
    helpMode: "**/mode** — змінити режим виконання",
    helpThoughtLevel: "**/think** — змінити рівень міркувань",
    helpReply: "**/reply** — змінити детальність відповідей",
    webhookSecretInvalid: "Не вдалося перевірити секрет вебхука.",
    callbackFailed: "Не вдалося обробити зворотний виклик бота: {message}",
    sessionExpiredNewTaskHint:
      "Сеанс поточного завдання завершився. Можливо, його очищено або це повідомлення бота застаріло. Надішліть **/new task**, щоб створити нове завдання й продовжити.",
    deletedTaskReplaced:
      "Попереднє завдання видалено, тому я створив для вас нове. Це повідомлення буде оброблено в новому завданні без історії попередньої розмови.",
    received: "Отримано.",
    attachmentOnlyPrompt: "Перегляньте вкладення й допоможіть на основі його вмісту.",
    attachmentRejected: "Не вдалося обробити вкладення: {message}",
    attachmentDownloadUnavailable:
      "Не вдалося завантажити вкладення. Можливо, термін дії файлу минув, його видалено або бот не має дозволу на його читання. Надішліть вкладення ще раз і повторіть спробу.",
    attachmentTooLarge: "Вкладення перевищує 5 МБ. Стисніть його й надішліть ще раз.",
    selectionCancelled: "Скасовано.",
    selectionCancelOption: "Скасувати",
    selectionTextHint: "Надішліть номер, щоб вибрати, або 0, щоб скасувати.",
    selectionTextHintNoCancel: "Надішліть номер, щоб вибрати.",
    newTaskDraft: "Створено чернетку нового завдання в {workspacePath}.",
    workspaceSelectTitle: "Поточний робочий простір: {workspace}\nВиберіть робочий простір",
    workspaceMissing: "Доступних робочих просторів не знайдено.",
    modelSelectTitle: "Виберіть модель",
    modelProviderSelectTitle: "Поточна модель: {model}\nВиберіть постачальника моделі",
    modelModelSelectTitle: "Поточна модель: {model}\nВиберіть модель",
    modelMissing: "Модель не знайдено.",
    sessionModelUnavailable:
      "Вибрана для сеансу модель недоступна. Виберіть її знову за допомогою /model. Ваш збережений вибір не змінено.",
    modeSelectTitle: "Поточний режим: {mode}\nВиберіть режим",
    modeMissing: "Варіант режиму не знайдено.",
    modeChanged: "Режим поточного завдання змінено на {mode}.",
    modeLocked: "Цей бот заблоковано в режимі виконання **yolo**, змінити його не можна.",
    thoughtLevelSelectTitle: "Поточний рівень міркувань: {level}\nВиберіть рівень міркувань",
    thoughtLevelMissing: "Поточна модель не підтримує рівні міркувань.",
    thoughtLevelChanged: "Рівень міркувань поточного завдання змінено на {level}.",
    modelProviderMissing: "Постачальника моделі не знайдено.",
    modelChanged: "Модель поточного завдання змінено на {model}.",
    taskMissing: "Завдання не знайдено.",
    taskChanged: "Перемкнуто на завдання: {title}",
    noActiveTask: "Немає активного завдання.",
    permissionExpired: "Термін дії цього запиту дозволу минув. Обробіть його в інтерфейсі zcode.",
    permissionHandled: "Запит дозволу вже оброблено.",
    permissionDenied: "Запит дозволу відхилено.",
    permissionSubmitted: "Відповідь на запит дозволу надіслано.",
    elicitationExpired: "Термін дії цього запитання минув. Обробіть його в інтерфейсі zcode.",
    elicitationHandled: "Запитання вже оброблено.",
    elicitationSubmitted: "Відповідь на запитання надіслано.",
    elicitationCancelled: "Запитання скасовано.",
    elicitationCustomOption: "Власна відповідь",
    elicitationCustomPlaceholder: "Введіть власну відповідь",
    elicitationQuestionTitle: "Запитання",
    planApprovalTitle: "Перегляньте цей план реалізації.",
    planApprovalHeader: "План реалізації",
    planApprovalApprove: "Схвалити",
    planApprovalApproveDescription: "Вийти з режиму планування й почати реалізацію.",
    elicitationCancelledCard: "✅ Запитання скасовано",
    elicitationSubmitOption: "Готово",
    elicitationSkipOption: "Пропустити",
    elicitationMultiSelectHint:
      "Можна вибрати кілька варіантів; виберіть варіант ще раз, щоб зняти вибір, а потім натисніть «Готово».",
    elicitationTextHint: "Також можна надіслати текст як власну відповідь.",
    statusWorkspace: "Робочий простір",
    statusModel: "Модель",
    statusTask: "Завдання",
    statusState: "Стан",
    statusWorked: "Тривалість роботи",
    statusProgress: "Прогрес",
    statusDraft: "чернетка",
    statusRemoteDisconnected: "віддалене з'єднання розірвано",
    statusCancelled: "скасовано",
    statusStopped: "зупинено",
    streamingStatusRunning: "Виконується",
    streamingStatusCompleted: "Завершено",
    streamingStatusFailed: "Помилка",
    streamingWorking: "Виконується...",
    streamingToolSummaries: "Підсумки інструментів",
    stopSubmitted: "Генерацію поточного завдання зупинено.",
    unknownCommand: "Невідома команда: **/{command}**",
    taskFailed: "Не вдалося виконати завдання: {message}",
    groupTaskQueued:
      "У поточного завдання ще є запити в черзі (воно може бути призупинене). Обробіть або приберіть їх у Desktop, перш ніж перемикати завдання; /stop не очищає чергу.",
    groupTaskInteraction:
      "Поточне завдання очікує на відповідь або підтвердження. Спершу завершіть цю взаємодію або зупиніть завдання командою /stop.",
    groupTaskDisconnected:
      "Віддалений робочий простір від'єднано, стан завдання перевірити неможливо. Спершу виконайте /reconnect.",
    taskRunning:
      "Поточне завдання ще виконується. Спробуйте пізніше або зупиніть його командою **/stop**.",
    taskSelectTitle: "Поточне завдання: {task}\nВиберіть завдання",
    noHistoryTasks: "У поточному робочому просторі немає завдань в історії.",
    remoteDisconnected:
      "Віддалений робочий простір {workspacePath} не підключено. Спершу надішліть **/reconnect**, а потім повторіть спробу. Попередній запит не виконано.",
    remoteDisconnectedStatus:
      "Віддалений робочий простір {workspacePath} не підключено. Надішліть **/reconnect**, щоб відновити з'єднання.",
    remoteWorkspaceSelectedDisconnected:
      "Перемкнуто на {workspacePath}, але віддалений робочий простір не підключено. Перш ніж виконувати завдання, надішліть **/reconnect**.",
    remoteReconnectStarting:
      "Віддалений робочий простір {workspacePath} не підключено. Підключаємо знову...",
    remoteReconnectFailed:
      "Не вдалося знову підключити віддалений робочий простір {workspacePath}: {message}\nПопередній запит не виконано.",
    remoteReconnectUnavailable:
      "Віддалений робочий простір {workspacePath} не підключено, а бот не має доступу до служби віддаленого підключення. Відкрийте цей віддалений проєкт у ZCode і повторіть спробу.",
    remoteReconnectLocal:
      "Поточний робочий простір локальний, тому повторно підключати його не потрібно. Надішліть **/workspace**, щоб перейти до віддаленого проєкту.",
    remoteReconnectAlreadyConnected: "Віддалений робочий простір {workspacePath} підключено.",
    replySelectTitle:
      "Поточна детальність відповідей для сторонніх сервісів: {mode}\nВиберіть детальність відповідей",
    replyMissing: "Варіант детальності відповідей не знайдено.",
    replyChanged: "Детальність відповідей для сторонніх сервісів змінено на {mode}.",
  },
} as const;

export type BotMessageId = keyof (typeof messages)[BotMessageLocale];

export function normalizeBotMessageLocale(locale: Locale | undefined): BotMessageLocale {
  // 未指定语言时保持中文默认；Bot 文案覆盖全部界面语言（含 uk-UA），
  // 不再经 toServiceLocale 折叠成 en-US，否则乌克兰语用户只能看到英文。
  return locale ?? DEFAULT_BOT_MESSAGE_LOCALE;
}

export function formatBotMessage(
  locale: Locale | undefined,
  id: BotMessageId,
  values: MessageValues = {},
): string {
  let message: string = messages[normalizeBotMessageLocale(locale)][id];
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return message;
}
