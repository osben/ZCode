import type { Locale, SkillScope } from "@zcode/shared";

interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "restore-legacy-sessions",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/restore-legacy-sessions-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

const BUILTIN_SKILL_DESCRIPTIONS: Record<string, Partial<Record<Locale, string>>> = {
  "android-dev": {
    "zh-CN": "通过 android-emulator MCP 工具构建、运行、检查并轻量自动化 Android 应用。",
    "en-US":
      "Build, run, inspect, and lightly automate Android apps through the android-emulator MCP tools.",
    "uk-UA":
      "Збирайте, запускайте, перевіряйте й частково автоматизуйте Android-застосунки за допомогою MCP-інструментів android-emulator.",
  },
  brainstorming: {
    "zh-CN":
      "在任何创造性工作前使用：创建功能、构建组件、增加能力或修改行为；先探索用户意图、需求和设计。",
    "en-US":
      "Use before any creative work, including creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements, and design before implementation.",
    "uk-UA":
      "Використовуйте перед будь-якою творчою роботою: створенням функцій, компонентів, додаванням можливостей або зміною поведінки. Спершу з'ясовує наміри користувача, вимоги та дизайн.",
  },
  "control-browser": {
    "zh-CN": "控制 ZCode 内置浏览器，用于打开、检查、点击、输入、截图或验证网页和本地开发页面。",
    "en-US":
      "Control ZCode's built-in browser to open, inspect, click, type, screenshot, or verify webpages and local development targets.",
    "uk-UA":
      "Керуйте вбудованим браузером ZCode: відкривайте, перевіряйте, натискайте, вводьте текст, робіть знімки екрана або перевіряйте вебсторінки й локальні сторінки розробки.",
  },
  "dispatching-parallel-agents": {
    "zh-CN": "面对 2 个以上彼此独立、无共享状态或顺序依赖的任务时使用。",
    "en-US":
      "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies.",
    "uk-UA":
      "Використовуйте, коли є 2+ незалежних завдання, які можна виконувати без спільного стану чи послідовних залежностей.",
  },
  docx: {
    "zh-CN":
      "完整的 DOCX 文档创建、编辑与分析能力，支持修订、批注、格式保持和文本提取。适用于创建新文档、修改内容、处理修订、添加批注或其它专业 Word 文档任务。",
    "en-US":
      "Create, edit, and analyze DOCX documents with revisions, comments, formatting preservation, and text extraction. Use for new documents, edits, revision handling, comments, and professional Word document work.",
    "uk-UA":
      "Створюйте, редагуйте й аналізуйте документи DOCX із виправленнями, коментарями, збереженням форматування та видобуванням тексту. Для нових документів, правок, роботи з виправленнями, коментарями й професійних документів Word.",
  },
  "executing-plans": {
    "zh-CN": "已有书面实现计划，并要在带评审检查点的独立会话中执行时使用。",
    "en-US":
      "Use when you have a written implementation plan to execute in a separate session with review checkpoints.",
    "uk-UA":
      "Використовуйте, коли є письмовий план реалізації, який треба виконати в окремому сеансі з контрольними точками перевірки.",
  },
  "finishing-a-development-branch": {
    "zh-CN": "实现已完成、测试通过、需要决定如何合并、发 PR 或清理分支时使用。",
    "en-US":
      "Use when implementation is complete, tests pass, and you need to decide how to integrate the work through merge, PR, or cleanup.",
    "uk-UA":
      "Використовуйте, коли реалізацію завершено, тести проходять і треба вирішити, як інтегрувати роботу: злиття, PR чи прибирання.",
  },
  "ios-dev": {
    "zh-CN": "通过 ios-simulator MCP 工具构建、运行、检查并轻量自动化 iOS 模拟器应用。",
    "en-US":
      "Build, run, inspect, and lightly automate iOS Simulator apps through the ios-simulator MCP tools.",
    "uk-UA":
      "Збирайте, запускайте, перевіряйте й частково автоматизуйте застосунки в iOS Simulator за допомогою MCP-інструментів ios-simulator.",
  },
  pdf: {
    "zh-CN":
      "专业 PDF 工具集，覆盖报告、创意视觉、学术 LaTeX 和现有 PDF 处理四条生产线。可按文档类型自动路由，支持报告、海报、论文、简历、提取、合并、拆分、表单填写和格式转换等任务。",
    "en-US":
      "Professional PDF toolkit for reports, creative visuals, academic LaTeX, and existing-PDF workflows. Supports reports, posters, papers, resumes, extraction, merge, split, forms, and conversion.",
    "uk-UA":
      "Професійний набір інструментів PDF для звітів, творчих макетів, академічного LaTeX і роботи з наявними PDF. Звіти, постери, статті, резюме, видобування, об'єднання, розділення, форми та конвертація.",
  },
  pptx: {
    "zh-CN":
      "检查并窄范围更新从 PPTX 预览区选择的元素。通过完整文件指纹和 OOXML 定位校验 shape 文本或表格单元格，冲突时停止而不猜测。",
    "en-US":
      "Inspect and narrowly update elements selected in PPTX Preview Pane. Verifies the whole-file fingerprint and OOXML locator for shape or table-cell text, and stops on conflicts instead of guessing.",
    "uk-UA":
      "Перевіряйте й точково оновлюйте елементи, вибрані в панелі попереднього перегляду PPTX. Звіряє відбиток усього файлу та OOXML-локатор тексту фігури чи клітинки таблиці й зупиняється за конфлікту, а не вгадує.",
  },
  "receiving-code-review": {
    "zh-CN":
      "收到代码评审反馈、准备实现建议前使用；尤其当反馈不清楚或技术上可疑时，需要严谨验证而非盲目同意。",
    "en-US":
      "Use when receiving code review feedback before implementing suggestions, especially when feedback is unclear or technically questionable.",
    "uk-UA":
      "Використовуйте, коли отримали відгуки code review, ще до впровадження пропозицій, особливо якщо відгук неясний або технічно сумнівний.",
  },
  "requesting-code-review": {
    "zh-CN": "完成任务、实现重大功能或合并前，用于请求代码评审以确认满足需求。",
    "en-US":
      "Use when completing tasks, implementing major features, or before merging to verify work meets requirements.",
    "uk-UA":
      "Використовуйте після завершення завдань, реалізації великих функцій або перед злиттям, щоб перевірити, що робота відповідає вимогам.",
  },
  "restore-legacy-sessions": {
    "zh-CN": "检查、规划或执行 ACP 时代 ZCode 旧 session 恢复到新的 ZCode 任务与会话库。",
    "en-US": "Inspect, plan, or restore old ACP-era ZCode sessions into the new ZCode task and session stores.",
  },
  "plugin-creator": {
    "zh-CN": "创建、校验 ZCode 插件，并指导本地安装与更新。",
    "en-US": "Create and validate ZCode plugins, and guide local installation and updates.",
    "uk-UA":
      "Створюйте й перевіряйте плагіни ZCode, а також отримуйте інструкції з локального встановлення та оновлення.",
  },
  "skill-creator": {
    "zh-CN":
      "创建新技能、编辑现有技能并迭代措辞。适用于从零编写 SKILL.md、改进已有技能、把重复工作流沉淀为可复用技能，或优化技能描述以提升触发可靠性。",
    "en-US":
      "Create new skills, edit existing skills, and iterate wording. Use for writing SKILL.md from scratch, improving skills, capturing repeated workflows, or tuning descriptions for reliable triggering.",
    "uk-UA":
      "Створюйте нові навички, редагуйте наявні та вдосконалюйте формулювання. Для написання SKILL.md з нуля, покращення навичок, фіксації повторюваних процесів або налаштування описів для надійного спрацьовування.",
  },
  "subagent-driven-development": {
    "zh-CN": "在当前会话中执行包含独立任务的实现计划时使用。",
    "en-US":
      "Use when executing implementation plans with independent tasks in the current session.",
    "uk-UA":
      "Використовуйте для виконання планів реалізації з незалежними завданнями в поточному сеансі.",
  },
  "systematic-debugging": {
    "zh-CN": "遇到任何 bug、测试失败或异常行为时，在提出修复前使用。",
    "en-US":
      "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.",
    "uk-UA":
      "Використовуйте за будь-якої помилки, падіння тесту чи неочікуваної поведінки, ще до пропонування виправлень.",
  },
  "test-driven-development": {
    "zh-CN": "实现任何功能或 bugfix 时，在编写实现代码前使用。",
    "en-US": "Use when implementing any feature or bugfix, before writing implementation code.",
    "uk-UA":
      "Використовуйте під час реалізації будь-якої функції чи виправлення, ще до написання коду реалізації.",
  },
  "using-git-worktrees": {
    "zh-CN":
      "开始需要隔离的功能工作或执行实现计划前使用，确保存在隔离 workspace，优先使用原生工具，否则回退 git worktree。",
    "en-US":
      "Use when starting feature work that needs isolation or before executing implementation plans. Ensures an isolated workspace exists via native tools or git worktree fallback.",
    "uk-UA":
      "Використовуйте на початку роботи над функцією, що потребує ізоляції, або перед виконанням планів реалізації. Забезпечує ізольований робочий простір нативними засобами або через git worktree.",
  },
  "using-superpowers": {
    "zh-CN":
      "开始任何对话时使用；说明如何查找和使用技能，并要求在任何回复包括澄清问题前调用 Skill 工具。",
    "en-US":
      "Use when starting any conversation. Establishes how to find and use skills, requiring Skill tool invocation before any response including clarifying questions.",
    "uk-UA":
      "Використовуйте на початку будь-якої розмови. Визначає, як знаходити й використовувати навички: інструмент Skill треба викликати перед будь-якою відповіддю, зокрема перед уточнювальними запитаннями.",
  },
  "verification-before-completion": {
    "zh-CN":
      "准备声明工作完成、已修复或测试通过前使用；要求先运行验证命令并确认输出，先有证据再下结论。",
    "en-US":
      "Use before claiming work is complete, fixed, or passing. Requires running verification commands and confirming output before success claims.",
    "uk-UA":
      "Використовуйте, перш ніж стверджувати, що роботу завершено, виправлено чи тести проходять. Вимагає запустити команди перевірки й підтвердити результат.",
  },
  "web-gui-tester": {
    "zh-CN":
      "使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试，通过真实用户交互、DOM 语义证据和截图验证功能、交互与响应式布局。",
    "en-US":
      "Run pure GUI black-box tests against websites and local web frontends with ZCode Browser Use, combining real user interactions, semantic DOM evidence, and inspected screenshots.",
    "uk-UA":
      "Виконуйте суто GUI-тестування методом чорної скриньки для вебсайтів і локальних вебфронтендів за допомогою ZCode Browser Use: реальні дії користувача, семантичні дані DOM і перевірені знімки екрана.",
  },
  "writing-plans": {
    "zh-CN": "已有规格或多步骤任务需求，在动代码前用于编写实现计划。",
    "en-US":
      "Use when you have a spec or requirements for a multi-step task, before touching code.",
    "uk-UA":
      "Використовуйте, коли є специфікація або вимоги до багатокрокового завдання, ще до зміни коду.",
  },
  "writing-skills": {
    "zh-CN": "创建新技能、编辑现有技能或在发布前验证技能是否有效时使用。",
    "en-US":
      "Use when creating new skills, editing existing skills, or verifying skills work before deployment.",
    "uk-UA":
      "Використовуйте для створення нових навичок, редагування наявних або перевірки, що навички працюють, перед розгортанням.",
  },
};

export function resolveSkillSourceLabel(scope: SkillScope, locale?: Locale): string {
  if (locale === "zh-CN") {
    if (scope === "workspace") return "工作区";
    if (scope === "plugin") return "插件";
    return "用户";
  }
  if (locale === "uk-UA") {
    if (scope === "workspace") return "Робочий простір";
    if (scope === "plugin") return "Плагін";
    return "Користувач";
  }
  if (scope === "workspace") return "Workspace";
  if (scope === "plugin") return "Plugin";
  return "User";
}

export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
  locale?: Locale,
): string {
  const descriptions = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]
    : undefined;
  // 未翻译的语言回退英文描述，避免露出 skill 自带的（可能是中文的）原始描述。
  const localized = descriptions?.[locale ?? "en-US"] ?? descriptions?.["en-US"];
  return localized ?? skill.description;
}

function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
