import type { ZCodeCopy } from "../types.js";

const pluralRules = new Intl.PluralRules("uk-UA");

function plural(count: number, one: string, few: string, many: string): string {
  const category = pluralRules.select(count);
  if (category === "one") return one;
  if (category === "few") return few;
  return many;
}

export const ukUA: ZCodeCopy = {
  locale: "uk-UA",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Непідтримуване значення --locale: ${value}. Підтримувані мови: en-US, zh-CN, uk-UA, auto.`,
    },
    help: (version) => `zcode ${version}

Використання:
  zcode [command] [options]

Без команди zcode відкриває повноекранний TUI.

Команди:
  app-server Запустити stdio-сервер застосунку ZCode Protocol
  commands   Показати користувацькі слеш-команди (\`commands list\`)
  doctor     Перевірити середовище виконання та припущення пакування
  login [zai|bigmodel]  Увійти через авторизацію в браузері
  logout     Видалити спільні облікові дані входу Z.AI
  plugins    Керувати плагінами й маркетплейсами (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; псевдонім: plugin)
  skills     Показати локальні навички (\`skills list\`)
  tui        Відкрити термінальний інтерфейс
  version    Показати версію CLI

Параметри:
  -h, --help       Показати довідку
  -v, --version    Показати версію
  -p, --prompt <text>  Виконати один промпт без відкриття TUI
  --enable-workflow  Увімкнути динамічні робочі процеси для --prompt або --target (типово: вимкнено)
  --memory-bench   З --prompt увімкнути автоматичне вилучення пам'яті й чекати перед виходом (потрібна ввімкнена пам'ять)
  --browser-use <mode> Увімкнути бекенд Browser Use (підтримується: headless)
  --surface <surface>  Поверхня відображення для headless-промптів/app-server: terminal або desktop
  --browser-executable <path> Виконуваний файл Chrome/Chromium для headless Browser Use
  --attach <path>  Прикріпити локальний файл до --prompt; повторіть для кількох файлів
  --cwd <path>     Виконати команду з указаного каталогу
  --disallowed-tools, --disallowedTools <tools...>
    Вилучити інструменти повністю лише для цього запуску промпту/TUI; збережені налаштування не змінюються.
    Назви інструментів через кому або пробіл, напр. "Bash Edit".
    "Bash(git *)" вилучає весь Bash; шаблони команд не зіставляються.
  --force-mcs      Примусово вмикати системну проєкцію посеред розмови для провайдерів Anthropic
  --locale <locale>  Мова інтерфейсу: en-US, zh-CN, uk-UA або auto
  --mode <mode>    Режим дозволів для промптів: build, edit, plan або yolo (типово: yolo для --prompt)
  --resume <sessionId>  Відновити збережений сеанс за sessionId (sess_...)
  --target <text>  Виконати або встановити мету сеансу в headless-режимі
  --target-replace Замінити наявну мету сеансу, встановлену через --target
  -c, --continue        Відновити останній сеанс для поточного каталогу
  --json           Виводити машинозчитуваний JSON, де це підтримується
  --no-browser     Показати URL OAuth без відкриття браузера
  --no-color       Вимкнути кольори ANSI
  --verbose        Виводити додаткові діагностичні відомості

Слеш-команди:
  /help [command]       Показати довідку щодо слеш-команд
  /login                Вибрати вхід через браузер у Z.AI або BigModel
  /logout               Видалити спільні облікові дані входу Z.AI
  /compact [instructions]  Стиснути поточну розмову
  /expert [status|resume|stop|<task>]  Запустити експертний робочий процес або керувати ним
  /dwf [list|cancel|resume]  Показати, скасувати або відновити запуски динамічних робочих процесів
  /fork [latest|checkpointId]  Створити новий сеанс із контрольної точки робочого простору
  /mcp [list|status|connect|disconnect]  Показати сервери MCP або керувати ними
  /mode [mode]          Показати або змінити режим дозволів: build, edit, plan або yolo
  /model [id]           Показати або змінити модель поточного сеансу
  /new                  Почати новий сеанс у TUI
  /resume [sessionId]   Відновити сеанс за sessionId; без нього — останній у cwd
  /rewind [latest|checkpointId]  Показати останню контрольну точку або відновити файли робочого простору
  /skill [name] [task]  Показати навички або примусово завантажити одну для наступного промпту
  /goal [action]        Показати або встановити мету поточного сеансу
`,
  },
  tui: {
    copy: {
      copied: "Виділений текст скопійовано в буфер обміну.",
      failed: "Не вдалося скопіювати виділений текст.",
      unavailable: "Копіювання тексту в буфер обміну недоступне в цьому терміналі.",
    },
    effort: {
      disabled: "вимкнено",
      enabled: "увімкнено",
    },
    input: {
      activeStatusHint: "esc — перервати",
      busyPlaceholder: "Введіть текст, щоб додати в чергу",
      placeholder: "Введіть промпт",
      queuedMore: (count) => `+ ще ${count} у черзі`,
      queuedSubmitHint: "Буде надіслано після наступного виклику інструмента.",
      queuedTitle: (count) => ` Черга (${count}) `,
      title: "Введення",
      noHistorySource: "Джерело історії введення не налаштовано.",
      noPreviousInput: "Для цього проєкту немає попереднього введення.",
      restoredPreviousInput: "Попереднє введення відновлено.",
      restoredPreviousInputWithAttachments: (count) =>
        `Попереднє введення відновлено з ${count} ${plural(count, "вкладенням", "вкладеннями", "вкладеннями")}.`,
      restorePreviousInputFailed: "Не вдалося відновити попереднє введення.",
      typePrompt: "Введіть запитання й натисніть Enter.",
    },
    loginRequired: {
      help: "Скористайтеся /model, щоб переглянути моделі, або /login, щоб під'єднати обліковий запис Coding Plan.",
      message: "Немає доступних моделей. Налаштуйте провайдера або увійдіть через /login.",
      status: "Немає доступних моделей. Налаштуйте провайдера або увійдіть через /login.",
      title: "потрібно налаштувати модель",
    },
    loginSetup: {
      emptyMessage: "Немає доступних способів входу.",
      help: "Стрілки вгору/вниз — вибір, Enter — підтвердити.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Введіть API-ключ BigModel Coding Plan",
          inputSecondary: "Вставте ключ сюди. Під час введення його приховано.",
          primary: "API-ключ BigModel Coding Plan",
          secondary: "Вставити API-ключ Coding Plan вручну.",
        },
        bigmodelOauth: {
          pendingPrimary: "Очікування авторизації BigModel",
          pendingSecondary: "Завершіть вхід у браузері. Авторизацію буде виявлено автоматично.",
          primary: "BigModel Coding Plan",
          secondary: "Відкрити вхід у браузері; авторизацію буде виявлено автоматично.",
        },
        chatgptOauth: {
          pendingPrimary: "Очікування авторизації ChatGPT",
          pendingSecondary:
            "Завершіть вхід у браузері за допомогою облікового запису ChatGPT Plus/Pro.",
          primary: "ChatGPT Plan",
          secondary: "Продовжити з ChatGPT (офіційний обмін токенами OpenAI).",
        },
        zaiApiKey: {
          inputPrimary: "Введіть API-ключ Z.AI Coding Plan",
          inputSecondary: "Вставте ключ сюди. Під час введення його приховано.",
          primary: "API-ключ Z.AI Coding Plan",
          secondary: "Вставити API-ключ Coding Plan вручну.",
        },
        zaiOauth: {
          pendingPrimary: "Очікування авторизації Z.AI",
          pendingSecondary: "Завершіть вхід у браузері. Роботу буде продовжено після авторизації.",
          primary: "Z.AI Coding Plan",
          secondary: "Відкрити вхід у браузері та створити API-ключ Coding Plan.",
        },
      },
      pending: {
        cancelStatus: "Вхід скасовано. Виберіть спосіб налаштування.",
        help: "Esc скасовує й повертає до вибору способу налаштування.",
        status: "Очікування авторизації в браузері...",
      },
      input: {
        cancelStatus: "Введення API-ключа скасовано. Виберіть спосіб налаштування.",
        clearStatus: "Поле API-ключа очищено.",
        emptyStatus: "Потрібен API-ключ.",
        help: "Enter зберігає ключ. Esc повертає до вибору способу налаштування.",
        placeholder: "Вставте API-ключ",
        status: "Введіть API-ключ і натисніть Enter.",
        submitStatus: "Збереження API-ключа...",
      },
      prompt: "Виберіть спосіб входу або налаштування API-ключа.",
      response: "Виберіть, як налаштувати провайдера Coding Plan.",
      title: "Налаштування Coding Plan",
    },
    model: {
      requestFailed: (message) => `Помилка запиту до моделі: ${message}`,
      responseReceived: "Відповідь моделі отримано.",
      responseReceivedWithTokens: (tokens) => `Відповідь моделі отримано. Токенів: ${tokens}.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Повторний запит до моделі ${attempt}/${Math.max(1, maxAttempts - 1)} через ${delay}: ${reason}`,
      streamStalled: "Потік моделі завис.",
    },
    sidebar: {
      subagents: {
        title: "Субагенти",
        empty: "Субагентів поки немає.",
        emptyOutput: "Виводу поки немає.",
        back: "← Основна розмова",
        readonly: "Лише читання · Esc — повернутися",
        loading: "Завантаження виводу субагента...",
        unavailable: "Вивід субагента недоступний.",
        retry: "Повторити",
        more: "Завантажити ще",
        pendingMain: "Основна розмова чекає на вашу відповідь — поверніться, щоб відповісти",
        ended: (count) => `Завершені (${count})`,
        status: {
          running: "виконується",
          waiting: "очікує",
          blocked: "заблоковано",
          success: "завершено",
          failed: "помилка",
          cancelled: "скасовано",
          lost: "втрачено",
        },
      },
      api: {
        empty: "Викликів API поки немає.",
        model: "Модель",
        more: (count) => `ще +${count}`,
        requests: "Запити",
        server: "Сервер",
      },
      cache: {
        hit: "влучання",
        lastHit: "останнє влучання",
        lastMiss: "останній промах",
        readWrite: ({ read, write }) => `${read} читання / ${write} запис`,
        total: "усього",
      },
      context: {
        cache: "Кеш",
        cacheReadWrite: "Кеш Ч/З",
        inputOutput: "В/В",
        reason: "Міркування",
        tokens: "Токени",
        used: "Використано",
        window: "Вікно",
      },
      modifiedFiles: {
        empty: "Змін у файлах поки немає.",
        more: (count) => `ще +${count}`,
      },
      mcp: {
        empty: "Сервери MCP не налаштовано.",
        loadFailed: "Стан MCP недоступний.",
        loading: "Завантаження стану MCP...",
        more: (count) => `ще +${count}`,
        servers: "Сервери",
        status: {
          connected: "під'єднано",
          connecting: "під'єднання",
          disabled: "вимкнено",
          disconnected: "від'єднано",
          failed: "помилка",
          untrusted: "ненадійний",
        },
        summary: ({ connected, total }) => `під'єднано ${connected}/${total}`,
        tools: (count) => `${count} ${plural(count, "інструмент", "інструменти", "інструментів")}`,
      },
      request: {
        complete: "завершено",
        error: "помилка",
        errorWithStatus: (statusCode) => `помилка ${statusCode}`,
        pending: "очікує",
      },
      status: {
        last: "Останнє",
      },
      run: {
        draft: "Чернетка",
        draftChars: (count) => `${count} ${plural(count, "символ", "символи", "символів")}`,
        draftEmpty: "порожня",
        messages: "Повідомлення",
        mode: "Режим",
        model: "Модель",
        provider: "Провайдер",
        thought: "Міркування",
        trace: "Трасування",
        turn: "Хід",
        workspace: "Робочий простір",
      },
      sections: {
        apis: "API",
        context: "Контекст",
        mcp: "MCP",
        modifiedFiles: "Змінені файли",
        run: "Запуск",
        status: "Стан",
        todos: "Справи",
      },
      shellSubtitle: "Оболонка OpenTUI",
      title: "Бічна панель",
      todos: {
        empty: "Справ поки немає.",
        more: (count) => `ще +${count}`,
        progress: "Прогрес",
      },
    },
    status: {
      compactFailed: "Не вдалося стиснути контекст.",
      compacted: "Розмову стиснуто.",
      compacting: "Стиснення контексту...",
      interruptedStreamDiscarded: "Перерваний потік моделі відкинуто.",
      modelCalling: "Виклик моделі...",
      permissionRequested: (toolName) => `Запитано дозвіл для ${toolName}.`,
      permissionResolved: (toolName) => `Дозвіл для ${toolName} вирішено.`,
      ready: "Готово.",
      recoveringStream: "Відновлення перерваного потоку моделі...",
      retryingStream: "Повторна спроба потоку моделі...",
      sessionResumed: "Сеанс відновлено.",
      targetChanged: (action) => `Мета: ${action}.`,
      thinking: "Міркує...",
      toolCompleted: (toolName) => `Інструмент ${toolName} завершив роботу.`,
      toolFailed: (toolName) => `Помилка інструмента ${toolName}.`,
      toolPending: (toolName) => `Інструмент ${toolName} очікує.`,
      toolRunning: (toolName) => `Інструмент ${toolName} виконується.`,
      turnFailed: "Хід завершився помилкою.",
    },
    terminal: {
      requiresInteractive: "TUI потребує інтерактивного термінала.",
      starting: "Запуск ZCode... Ctrl+C — вийти",
    },
    transcript: {
      compact: {
        completed: "Контекст стиснуто",
        failed: "Не вдалося стиснути контекст",
        interrupted: "Стиснення контексту перервано",
        retry: (command) => `Ctrl-R — повторити ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Повторне стиснення контексту (${attempt}/${maxAttempts})`
            : "Повторне стиснення контексту",
        skipped: "Контекст актуальний; стиснення не потрібне",
        started: "Стиснення контексту",
      },
      roles: {
        agent: "Агент",
        system: "Система",
        user: "Користувач",
      },
      thought: {
        complete: "Міркування",
        thinking: "Міркує...",
      },
      title: "Розмова",
      workflow: {
        actors: "виконавці:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) =>
          `використано: ${spentTokens} ${plural(spentTokens, "токен", "токени", "токенів")}`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Робочий процес ${label} - ${status} (кроків: ${nodesSettled}/${nodesTotal})`,
        error: (message) => `помилка: ${message}`,
        expandHint: "+ — розгорнути",
        collapseHint: "- — згорнути",
        log: "журнал:",
        nodes: ({ nodesSettled, nodesTotal }) => `завершено кроків: ${nodesSettled}/${nodesTotal}`,
        result: (preview) => `результат: ${preview}`,
        status: {
          completed: "завершено",
          errored: "помилка",
          pending: "очікує",
          running: "виконується",
          stopped: "зупинено",
        },
        stopReason: {
          user: "вами",
          model: "агентом",
          provider: "помилка моделі",
          interrupted: "процес завершився",
          superseded: "замінено зміненим запуском",
        },
        truncated: "(скорочено — повна історія в журналі запуску)",
        interruptedNotice: ({ label, runId }) =>
          `Робочий процес ${label} перервано, його можна відновити: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter — вибрати, Esc — скасувати",
      disabled: (reason) => ` [вимкнено: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `фільтр: ${filter || "-"} | ${help ?? "Enter — вибрати, Esc — скасувати"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Немає відповідних шляхів у робочому просторі.",
      loading: "Завантаження шляхів робочого простору...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Файли",
    },
    slash: {
      title: "Команди",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
