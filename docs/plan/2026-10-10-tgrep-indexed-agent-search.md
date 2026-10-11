# План: индексированный поиск агента через tgrep

Статус: implementation handoff; продуктовый код не изменён. Техническая квалификация ещё не выполнена, выпуск не одобрен.

Читатель: разработчик ZCode. Задача документа — реализовать включение поиска одним переключателем, сохранив работоспособность и семантику существующего поиска.

## Начало новой ИИ-сессии

Рабочий checkout при подготовке: `/Users/osben/.codex/worktrees/8f42/ZCode`, HEAD `40de77e4`. Это историческая точка отсчёта: новый исполнитель обязан проверить текущую ветку, diff и baseline. В этом checkout нет `node_modules`; проверки с `tsc`, `oxlint`, `oxfmt` ранее не запускались успешно из-за отсутствующих исполняемых файлов. Это ограничение окружения, не доказательство качества реализации.

1. Прочитать текущие `AGENTS.md`, `/Users/osben/.codex/RTK.md`, `mise.toml`, этот план и актуальный native-search spec. Выполнить freshness check и `git status`; сохранить чужие изменения. Не переносить автоматически версии и пути из документа в другой checkout.
2. Проверить инструменты через mise: сейчас Node **24.14.0**, pnpm **10.33.2**. При отсутствии зависимостей использовать существующие mise-задачи `install` и `bootstrap`, предварительно прочитав их определения. Не добавлять новую production dependency без согласования.
3. Выполнить architecture baseline и прочитать controlled context `zcode-cli`, `services`, `shared`; `ui` добавить перед UI-этапом. Зафиксировать baseline failures отдельно от новых ошибок.
4. Начать с этапа 1 и gate D09. Создать spec и воспроизводимый spike с native fixtures; не начинать с переключателя, выдающего `ready` по таймеру или boolean. Системный tgrep этой машины допустим для исследования, но не является доставкой продукта.
5. После каждого этапа записать в этом документе решение, изменённые файлы, выполненные команды и результат, оставшийся gate и следующий шаг. Не отмечать этап выполненным без его выходного доказательства. Commit/push/PR/deploy требуют отдельной авторизации.

Первая рабочая цель: **доказать доставку, совместимый запрос и свежесть на pinned build либо документировать блокирующую несовместимость**. Отрицательный результат spike — допустимый результат исследования; интерфейс с постоянно неактивным ускорением не считается выполненной фичей.

## Результат для пользователя

Вывод исследования: функция перспективна как экспериментальная opt-in возможность для повторных поисков по средним и большим репозиториям. Измерение на ZCode уже показало заметный выигрыш на прогретом индексе, но ещё не доказало полезность между правками, parity с текущим backend и acceptable resource cost. Поэтому не копировать автоматический порог Copilot и не включать default; сначала пройти gates ниже. Если строгая свежесть требует полного сканирования перед каждым запросом и съедает выигрыш, это основание отказаться от выбранной интеграции.

Пользователь включает «Ускорять поиск агента с помощью локального индекса» для выбранного workspace. Устанавливать tgrep, Rust, Homebrew или MCP вручную не требуется. ZCode предоставляет проверенный бинарник, запускает индексатор и переключает совместимые запросы после готовности индекса. Во время подготовки, после правок и при сбоях работает существующий поиск.

Основной способ доставки — бинарник в ресурсах ZCode, а не скачивание из GitHub при нажатии переключателя. Это позволяет включать функцию локально без интернета. Удалённый бинарник доставляется существующим механизмом подготовки runtime на целевой машине. Если ресурса нет, поиск остаётся рабочим, а настройка сообщает причину неактивного ускорения.

## Feature Summary

| Поле             | Значение                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Включение tgrep одним действием без системной установки                                                                      |
| Capability       | Расширение embedded-native-search; отдельная настройка индексирования                                                        |
| Change layer     | presentation, validation, commit-effect, persistence, recovery                                                               |
| Operating mode   | planning; реализация и публикация не входят в текущую задачу                                                                 |
| Primary seeds    | Runtime tool registry/resolver, native-search packaging, Bash prelude, filesystem search adapter, runtime-preferences bridge |
| Out of scope     | Семантический поиск, MCP, поиск по истории чатов, общий индекс нескольких worktree, автоматическое включение по порогу       |

## Clarification Log

| Основание                                       | Зафиксировано                                                                          | Статус                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| Пользователь                                    | У людей без установленного tgrep всё должно работать; переключатель активирует функцию | accepted                          |
| Предыдущая рекомендация и согласие пользователя | Начать с экспериментального включения для проекта                                      | accepted                          |
| Текущий код                                     | Основной поиск агента использует Bash; отдельный Grep обычно скрыт                     | confirmed                         |
| Текущая спецификация native search              | Переключатель bfs/ugrep — стартовая настройка runtime, не горячая настройка            | confirmed; не менять её семантику |
| Этот план                                       | Встроенная доставка, независимый живой переключатель, маршрутизация rg                 | proposed implementation           |

## Boundary Decisions

| Граница                | Решение                                                                                               | Исключается                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Установка              | Версия и SHA-256 фиксируются в ресурсах ZCode; управляемый бинарник вызывается по абсолютному пути    | Зависимость от PATH пользователя, brew/npm/cargo install, права администратора    |
| Пользовательский tgrep | Системный tgrep не требуется и не заменяется; для функции используется квалифицированная версия ZCode | Автоматическое доверие произвольной установленной версии                          |
| Настройка              | Отдельное persisted boolean, default false, scoped to workspace в пользовательских данных             | Запись настройки/индекса в репозиторий, изменение nativeSearchEnhancementsEnabled |
| Включение              | Действует на последующие поиски в уже открытом чате; первый запрос не ждёт построения                 | Перезапуск приложения/чата как обязательный шаг                                   |
| Выключение             | Следующие запросы идут прежним путём; принятый запрос может завершиться или отмениться штатно         | Обрыв всей сессии, удаление пользовательского tgrep                               |
| Корректность           | Неподтверждённая свежесть означает обычный поиск                                                      | Ожидание фиксированного timeout «чтобы индекс успел»                              |
| Малый проект           | Явное включение допускается; предварительный счёт файлов не блокирует поиск                           | Копирование порогов Copilot как обязательного условия                             |
| Неподдерживаемая среда | Ускорение недоступно с объяснением; существующий поиск остаётся                                       | Заявление об активном tgrep при фактическом fallback                              |

## UI Surface Matrix

| Сценарий / вход                           | Общая реализация                                      | Draft/display                                                              | Default / gating                             | Commit / authority                                                        | Mode / isolation                                            |
| ----------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Desktop: настройки выбранного проекта     | Settings components + workspace-aware hook            | UI показывает target и подтверждённое состояние; pending mutation локальна | default false; без workspace нельзя включить | SettingService сохраняет intent; execution-side search manager активирует | Не менять другие проекты или существующий bfs/ugrep toggle  |
| Web / mobile: настройки того же workspace | Тот же hook/service contract, responsive presentation | Серверная проекция; локальный клиент не запускает бинарник                 | Старый/отключённый Host не объявляется ready | Через существующий Host attachment                                        | Ни отдельного Agent, ни независимого мобильного индексатора |
| Уже открытый чат и Explore                | Общий execution search gateway                        | UI чата не владеет настройкой                                              | Per-request effective state                  | Agent получает capability текущего workspace                              | Не менять очередь, mode/model, owner/lease                  |
| CLI / standalone server                   | Тот же gateway и управляющий port                     | UI отсутствует; читается настройка execution Host                          | Нет нового обязательного CLI flag            | Host-side persisted preference                                            | Отсутствие настройки равно off                              |

В настройках добавить отдельную строку для поиска агента рядом с существующими настройками поиска; не объединять её с редактором .zcodeignore. Точное размещение проверить по DESIGN.md перед UI-кодом. При смене target отклонять ответы старого workspace.

Отображаемое состояние: «Выключено», «Подготовка», «Индексируется», «Активно», «Обновляется — используется обычный поиск», «Ускорение недоступно — используется обычный поиск». Показывать размер кеша и однократную понятную причину ошибки. Retry — явное повторение подготовки; постоянного цикла перезапусков нет. Requested=true не означает effective=tgrep.

## Shared And Divergent Behavior

| Concern              | Общее                                                                  | Различие                                                                                           |
| -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| UI/component         | Один контракт управления и статуса                                     | Desktop/Web/mobile используют существующие платформенные компоненты                                |
| Option source        | Переключатель default off                                              | Поддержка зависит от версии Host, OS/arch и файловой системы                                       |
| Default/inheritance  | Preference относится к workspace, не к session history                 | Desktop-attached remote получает intent от desktop settings authority; standalone — от своего Host |
| Validation           | Проверка бинарника, root, capability, freshness, совместимости запроса | Платформенные ограничения и поддержка shell различаются                                            |
| Commit effect        | Изменение intent и ревизии для следующих запросов                      | Remote ресурсы и процессы находятся на машине проекта                                              |
| Persistence/recovery | Intent восстанавливается; статус заново устанавливается                | Индекс и бинарник не синхронизируются между машинами                                               |

## State Owners And Commit Sinks

| State/fact                                           | Authoritative owner                                                        | Mirrors / commit / persistence                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Requested preference                                 | SettingService существующего settings authority                            | Workspace-scoped запись в пользовательском storage; UI получает подтверждённую проекцию                                                 |
| Binary qualification                                 | Native-search resource preparation/resolver на execution Host              | Version, target, archive digest, binary digest, schema/format                                                                           |
| Daemon/index lifecycle, effective state, dirty epoch | Workspace search manager в execution-side Agent bootstrap composition root | Один owner для сессий, Explore и субагентов этого Agent; IO запуска/индекса за adapter/port; shutdown связан с ProtocolRuntimeResources |
| Query policy и freshness guard                       | Тот же owner через query gateway                                           | Core получает живой port через DI; дочерний shell/CLI вызывает owner через проверенный локальный transport, а не копирует boolean       |
| Index bytes                                          | tgrep sidecar                                                              | Отдельный управляемый cache в профиле пользовательских данных                                                                           |
| UI pending/error                                     | Workspace-scoped hook/store                                                | Не считается серверным фактом; stale revisions отклоняются                                                                              |

Host services владеют сохранением intent и доставкой команд/проекций; runtime manager владеет применением intent и sidecar. Это разные факты, а не два владельца `ready`. Перед кодом закрепить новый публичный port в CLI contracts и shared protocol: имена ниже — проектируемый контракт, не существующее API. Services не импортируют конкретный Agent Runtime. Main/relay только маршрутизируют и планируют процессы; состояние поиска не помещается в Main.

Identity key: `workspaceIdentity?.trim() || workspacePath`, с существующим Host/server scope. `workspacePath` — только для файлов и cwd. Cache metadata дополнительно проверяет canonical root, версию формата и фильтры; разные worktree имеют независимые индексы. Одинаковый путь на двух удалённых машинах не объединяется. Не конструировать remote identity вручную.

Один in-memory owner не обеспечивает общий epoch между двумя Agent-процессами или двумя window-scoped Hosts. В v1 не строить отдельный глобальный broker. Для независимых процессов нужны раздельные управляемые index/daemon namespaces и доказательство свежести внешних записей; один OS-lock защищает запись кеша, но не полноту результатов. Если pinned tgrep обнаруживает сервер только по root и не позволяет безопасно изолировать владельцев, это блокирующий пункт квалификации, а не повод подключиться к чужому процессу. TG07 покрывает общий Agent; межпроцессный случай отдельно проверяется в TG08/D06 и до доказательства не объявляется поддержанным indexed режимом.

## Concept Map And Event Order

```mermaid
sequenceDiagram
    participant UI as Настройки workspace
    participant Settings as SettingService authority
    participant Host as Host services / transport
    participant Owner as Agent bootstrap search owner
    participant Agent as Agent search gateway
    participant TG as Управляемый tgrep
    UI->>Settings: Сохранить enabled + workspace identity
    Settings->>Host: Intent revision + workspace target
    Host->>Owner: Применить intent через typed protocol
    Owner->>Owner: Проверить ресурс и root; обеспечить singleflight
    Owner->>TG: Запустить owned sidecar и построить индекс
    Agent->>Owner: Допустить запрос по текущей policy
    Note over Agent: До готовности — существующий поиск
    TG-->>Owner: Доказательство готовности поколения
    Owner-->>Host: Status + owner instance + revision
    Host-->>UI: Подтверждённая проекция
    Agent->>Owner: Совместимый запрос, зафиксировать поколение
    Owner->>TG: Выполнить поиск
    Agent->>Owner: Invalidate до допуска изменяющей операции
    Note over Agent,Owner: Последующие поиски идут по файлам до подтверждённого обновления
```

Отдельно определить delivery команды preference/status для desktop-continuous и web-remote-replayable. После переподключения читать последний status, не повторять запуск как новую операцию. Один owner обслуживает несколько сессий/субагентов; закрытие одной сессии не останавливает индексатор остальных. Не терять настройку при временном отключении клиента. Guarded teardown проверяет принадлежность процесса и refs; на Windows освобождает root handles перед удалением/перемещением worktree.

## Контракт управления и состояние

Закрепить в spec и runtime validators следующий минимальный контракт, затем выбрать имена по существующим conventions. Не использовать `session/requestRuntimePreferences` как единственный канал: он обслуживает стартовые настройки и не даёт требуемого hot update.

| Операция / факт                | Минимальные данные и правило                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Сохранить intent               | Existing workspace target + enabled; SettingService присваивает монотонную preference revision. Повтор той же команды идемпотентен; restart не сбрасывает сохранённый intent                                |
| Применить intent               | Target + preference revision; runtime owner игнорирует более старую revision. Ответ подтверждает принятие, не готовность индекса                                                                            |
| Прочитать status / подписаться | Requested, applied preference revision, runtime owner instance, status sequence, phase, fallback reason, qualified version, nullable cache size. UI сравнивает sequence только внутри одного owner instance |
| Допустить query                | argv, cwd/root, stdin/TTY/output constraints, cancellation и workspace key; owner атомарно выбирает baseline или допустимое поколение. Разрешение на indexed search не кешируется в session                 |
| Invalidate / завершить запись  | Writer token + epoch до запуска эффекта; завершение освобождает writer, но само не делает индекс ready. Ошибка/отмена записи тоже может означать частично изменённые файлы                                  |

Persist только intent. PID, phase, ready, epoch и cache size — runtime facts, после restart восстанавливаются как `unknown`, затем проверяются. У неактивного workspace чтение статуса не должно само запускать Agent. Включение сохраняет intent; подготовка начинается при существующем либо следующем execution runtime, UI показывает ожидание запуска. Не вводить второй фоновый Agent ради этой настройки.

Переходы: `off → preparing → indexing → ready`; запись переводит `ready → dirty`, потеря доказательства — в `unknown`, ошибка ресурса/процесса — в `unavailable`. `dirty/unknown` используют baseline и могут вернуться в `ready` только через gate свежести. Везде `off` инвалидирует activation token; поздний build/status старого token не применяется. Повторное включение создаёт новый token. При old Host без capability setting может сохраняться, но статус не обещает ускорение.

Для уже запущенного запроса политика фиксируется при admission. Если writer начинается до публикации результата, gate обязан либо обеспечить подтверждённо актуальный результат, либо отбросить ещё не опубликованный результат и выполнить baseline. После начала streaming нельзя пересобрать результат незаметно. Этот конфликт проверяется барьерами, а не случайными sleep.

## Маршрутизация поиска

1. Добавить per-query выбор в Bash execution path, где уже формируется prelude. Не пытаться заменить только WASM Grep.
2. При включении направлять **репозиторный `rg`** через управляемый gateway в контексте Agent. Существующий `grep`/ugrep с BRE оставить как есть. Обновить guidance основного агента и Explore для использования rg при включённой функции, в том числе на следующем model step существующего чата.
3. Системный rg и terminal пользователя не менять. При fallback вызывать квалифицированный прежний executable без рекурсии в shell function, сохраняя argv, stdin, stdout, stderr, cancellation и exit code.
4. Ускорять только проверенный набор: литералы/поддерживаемые regex, пути внутри root, проверенные globs/types, регистр, строки/контекст, filenames/count. Набор определяется parity-тестами, а не названием «ripgrep-compatible».
5. Stdin/pipeline input, путь вне root, явные файлы, несовместимые regex/flags/encoding/ignore и неподдерживаемый shell идут через прежний backend. Отдельный FileSystemPort.searchText подключить тем же port после проверки семантики; все workflow-child/bootstrap defaults проверить отдельно.

Начальный allowlist должен быть минимальным: отдельный вызов `rg` с литералом и filenames-only либо простым line output, только после byte/exit parity. Regex, context, JSON, type/glob расширяют allowlist лишь отдельными тестами. Не включать весь список из TG10 сразу. Off возвращает прежний выбор executable; fallback при on сохраняет выбранный обычный backend и пользовательскую конфигурацию (`RIPGREP_CONFIG_PATH`, ignore environment, cwd). Если gateway не умеет доказать эффективные параметры config, использовать baseline. Нельзя объявить произвольный системный rg квалифицированным pinned бинарником.

Baseline означает **прежний путь поиска**, а не `tgrep --no-index`: отключение индекса не устраняет различия фильтров и regex engine. Для управляемого tgrep production lookup не должен автоматически наследовать существующий resolver priority env override → resources → PATH. У ресурса должна быть проверенная provenance; невалидный managed resource даёт unavailable, а не использование случайного системного tgrep.

**Bash admission — отдельный gate.** Нельзя просто повышать epoch для любого Bash, иначе поиск сам делает индекс dirty. Ускорять лишь доказанно чистый вызов поиска, используя уже имеющийся parser, если он действительно пригоден. Shell substitutions, redirects, background jobs, `cd`, pipelines и compound commands не распознавать набором regex как безопасные. Неизвестный Bash получает writer token до запуска и baseline на протяжении потенциальной записи; фоновой процесс удерживает dirty до подтверждённого завершения. Включить в fixture `write; rg`, `rg; write`, `$(write)`, перенаправление stdout в файл, alias/function override и retained background writer. Не добавлять новый parser dependency без отдельного согласования.

Shell function запускает отдельный процесс: прямой вызов TypeScript port из prelude невозможен. На этапе 1 доказать bridge через существующий internal CLI entry или другой минимальный adapter. Контракт bridge: live admission у того же owner, отдельный канал управления, неизменный search stdout, argv без shell interpolation, сохранение exit/cancel. Named pipe / Unix socket / loopback endpoint должен быть ограничен текущим пользователем, привязан к owner instance и root; endpoint/capability token не писать в логи. Отсутствие или несовместимость bridge означает baseline. Не создавать MCP или новый публичный сетевой сервис.

BRE grep, PCRE2/fancy-regex, бинарные расширения (включая PDF), положительные globs, ignore rules, symlinks, Unicode и CRLF — отдельные условия совместимости. Контекст/счёт/JSON и line/byte offsets проверяются, а не только список файлов. Отрицательный ответ tgrep не является доказательством полной совместимости.

Ошибку бинарника/индекса можно заменить одним обычным поиском с диагностикой. Invalid regex/permission/cancellation — сохранить ошибку и семантику, не скрывать её общим fallback. Если streaming уже выдал строки, не дописывать fallback поверх частичного вывода: обеспечить ограниченное буферизованное переключение либо закончить запрос явной ошибкой без дубликатов.

Buffer budget брать из существующих execution output limits; overflow не означает бесконечное накопление в RAM. Перед допуском sidecar/query сохраняются прежние permission/sandbox проверки. Bridge не может превращаться в обход denied root/file access; индекс с устаревшими правами не даёт права вернуть кешированное содержимое. Корпус cache приватен текущему пользователю, не публикуется и не синхронизируется с настройкой.

## Свежесть — обязательный технический gate

Из исследования: ordinary server tgrep 1.1.0 пять раз не увидел новое содержимое сразу после записи. Наблюдаемая задержка составила 40–74 мс; это не гарантированный максимум. Готовность индекса и отсутствие pending reconcile сами по себе не подтверждают read-after-write.

До активации определить проверяемый контракт freshness:

- Dirty epoch повышается **до** допуска Edit/Write/ApplyPatch, изменяющего Bash, смены ветки, create/delete/rename и неизвестной файловой операции. Общий workspace guard распространяется на остальные сессии и субагентов.
- В dirty/unknown состоянии весь запрос идёт прежним backend; проверка только пустых результатов недостаточна, поскольку могут пропасть отдельные совпадения.
- Пропущенные/переполненные watcher events, polling fallback, reconnect/restart и изменение ignore policy переводят индекс в unknown. Fixed sleep не возвращает ready.
- Возврат к indexed разрешается только после подтверждения поколения, покрывающего нужный epoch. В spike проверить возможности **зафиксированной версии**, а не только main README. Если ordinary CLI не даёт acknowledgement, предусмотреть управляемую полную пересборку нового поколения с epoch guard и атомарным переключением; не придумывать существующую команду sync.
- Если ни один вариант не обеспечивает нужную корректность с приемлемыми затратами, stop gate: ускорение после изменений остаётся недоступным с обычным поиском. Для выпуска нужен отдельный согласованный контракт, а не ослабление гарантий молча.

Полная пересборка — **кандидат для spike**, не готовое решение: concurrent writers, cache policy, server auto-discovery и момент publication также должны быть покрыты. Быстрые mtime/size проверки не доказывают неизменность содержимого. Обычный async watcher не гарантирует, что внешняя запись уже замечена перед query. Если требования TG06/TG08 нельзя выполнить без полного scan, upstream patch или изменения продуктовой гарантии, зафиксировать конкретный failing case и остановить indexed активацию. Не обещать строгую свежесть внешних/межпроцессных записей на основании одного локального epoch.

Параллельные внешние изменения не обещать как атомарный снимок файловой системы. Сравнивать поведение с живым обычным поиском, отдельно проверять редактор, git checkout, восстановленные mtime/size, смену правил и пропущенные уведомления. Для неизвестной свежести выбирать обычный поиск.

## Доставка, ресурсы и ошибки

Desktop, SEA/CLI, server-cli и remote assets используют одну version/target map через существующий native-search pipeline. Кандидат исследования — upstream v1.1.0; окончательный pin принимается после квалификации. Проверены опубликованные архивы macOS/Linux/Windows x64 и arm64; размер сжатого архива 2,57–3,21 МиБ. Наличие архива не доказывает соответствие минимальной OS ZCode или успешную работу на target.

Проверить лицензии/notices, SHA-256, архитектуру, executable permissions, macOS deployment target/signing, Linux musl или GLIBC baseline, Windows CRT/signing, AV/quarantine и формат индекса. Изменение version/format не читает несовместимый старый кеш как ready. Runtime не компилирует инструмент на компьютере пользователя.

Первичная установка remote может требовать доступа к штатному источнику runtime resources. Эта доставка не блокирует существующий чат/поиск. Локальный desktop с корректным пакетом должен активироваться офлайн. При неполном dev/старом пакете отсутствие tgrep явно диагностируется; не выдавать автоматическое системное install как решение.

Предусмотреть read-only workspace, writable user cache, disk-full, отсутствие доступа, удалённый root, cloud-sync/network filesystem, OOM/crash и watch failures. Начальный indexed режим допускает только квалифицированные filesystem conditions; unknown означает fallback. CPU/memory flags upstream нельзя объявлять hard limits без проверки конкретного build; особенно initial external build.

Кеш: вне проекта, ограниченный retention по последнему использованию; explicit clear/rebuild действует только на управляемый индекс нужного workspace. Выключение сохраняет пригодный кеш. Очистка не затрагивает активное поколение/читателя; переход между версиями и удалённым root безопасен. Размер/лимиты выбрать по измерениям, а не выдуманным универсальным цифрам.

Логи через существующие UI/service loggers: version, effective engine, duration, fallback reason, lifecycle. Не писать содержимое файлов, поисковые шаблоны, credentials или внутренние адреса. Не логировать каждый запрос на info. OOM/crash не вызывает бесконечного restart; повторная попытка явно ограничена или инициирована пользователем.

## Feature Relationships

| Rank           | Связь                                                     | Почему / evidence                                                                              |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| must-inspect   | Native resource preparation -> binary qualification       | RuntimeTool registry/resolver и prepareNativeSearchTools обслуживают bundled resources         |
| must-inspect   | Settings -> Host reverse preferences -> execution manager | nativeSearchEnhancementsEnabled уже проходит Host authority; нельзя сделать remote-local копию |
| must-inspect   | Bash prelude -> search gateway -> native tools            | Текущий grep uses ugrep -G; rg fallback не shadow installed rg                                 |
| must-inspect   | File mutation / git -> workspace freshness gate           | Индекс обновляется асинхронно; guard должен быть общим для readers                             |
| should-inspect | Grep adapter / workflow reads / Explore -> query policy   | FileSystemPort.searchText используется не только отдельным Grep                                |
| conditional    | Windows shell / remote deployment -> capability           | Нативные ресурсы и POSIX prelude имеют разные условия                                          |
| invariant-only | Mobile attachment / owner lease / worktree isolation      | Не создавать новый runtime, не смешивать root и identity                                       |
| evidence-only  | Existing native search, prelude, fs tests                 | База для regression, не доказательство tgrep parity                                            |

## Must-Preserve Invariants

| Invariant                                                        | Proof needed                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Нет системного tgrep — обычный поиск работает с off и on         | Clean-machine packaged test, PATH без tgrep                             |
| Включение требует одного переключателя                           | Packaged offline activation, existing chat, доказательство engine=tgrep |
| tgrep off не меняет существующий native search                   | 2x2 matrix обоих переключателей                                         |
| Неподтверждённый индекс не сообщает полное отсутствие совпадений | Controlled write-before-search, multi-session, stale/unknown cases      |
| Изоляция workspace/worktree/Host                                 | Same path different remote host, sibling worktree, stale UI response    |
| Результаты и права не меняются ради скорости                     | Parity corpus, deny/cancel, stdout/exit checks                          |

## Codegraph Evidence

Codegraph tool в этой сессии недоступен. Impact глубины 2 проверен точными ссылками исходников; полноту статической call graph не заявляем. Перед реализацией повторить graph scan, если инструмент доступен.

| Seed                              | Direct callers / key path                                                                                | Depth / interpretation                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| resolveNativeSearchPrebuiltPlan   | prepareNativeSearchTools; desktop/SEA/remote resource preparation                                        | 2; доставка                                                      |
| buildRuntimeToolEnvPatch          | runtimeCommandEnv -> services bootstrap                                                                  | 2; execution env                                                 |
| buildEmbeddedSearchPreludeContent | Bash startup script -> execution adapter                                                                 | 2; основной gateway                                              |
| nativeSearchEnhancementsEnabled   | SettingsPage -> useSettings; Host runtime preferences -> session materialization -> subagent inheritance | 2 + targeted terminal sinks; существующая настройка startup-only |
| NodeFileSystemAdapter.searchText  | Grep handler и workflow-world-read; отдельные createNodeFileSystemAdapter bootstrap paths                | 2; secondary paths                                               |

## Graph Drift Candidates And Graph Delta

Existing graph capability.embedded-native-search не содержит будущие indexed preference/status/freshness owner. Proposed delta: добавить tgrep alias, отдельный UI surface, execution-side manager, persistence и freshness edges после квалификации выбранной схемы. Технически неподтверждённый daemon/epoch contract не объявлять уже существующим продуктовым фактом. Граф в текущем планировании не изменён.

Старый embedded-search-provider-visible документ содержит устаревшие default internal-cli/WASM rg положения; текущие source и embedded-search-native-build spec подтверждают native binaries и другую lifecycle настройку. Исправить только связанные места при реализации, не восстанавливать прежние пути.

## Domain Scope, Dimensions And High-Risk Cross-Products

Primary domains: runtime tools, permission/search compatibility, workspace identity/persistence, settings/recovery. Conversation turn/queue/compact semantics не меняются; проверяются как инварианты, не строится полный formal-proof Cartesian product.

Размерности: requested off/on; effective unavailable/preparing/indexing/ready/dirty; native search off/on; packaged/dev/old Host; local/SSH/WSL/Docker; OS/arch/shell; ready/disconnected/reconnected; compatible/unsupported query; clean/mutating/worktree-switched root. Pairwise плюс рискованные сочетания ниже.

## Candidate Combinations, Pruning Decisions And Unresolved Questions

| ID  | Combination                                                | Status / guard / решение                                                                                                                       |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | tgrep on + system tgrep missing + packaged local offline   | accepted; ресурс ZCode, один переключатель                                                                                                     |
| D02 | tgrep on + native search off                               | accepted; rg gateway независим от find/grep enhancement                                                                                        |
| D03 | tgrep on + ready + compatible repository rg                | accepted; tgrep backend proof                                                                                                                  |
| D04 | tgrep on + dirty/unknown/partial + любой query             | accepted; прежний backend                                                                                                                      |
| D05 | ready + stdin/BRE/PCRE2/unsupported flags/outside root     | accepted; прежний backend, exact semantics                                                                                                     |
| D06 | one workspace + two sessions / independent Agent processes | same-Agent accepted; independent processes требуют отдельного proof внешних изменений и daemon isolation, иначе indexed mode не квалифицирован |
| D07 | shared Git base across worktrees                           | pruned; отдельные ordinary indexes в v1                                                                                                        |
| D08 | auto thresholds / forced unsafe filesystem                 | pruned; вне v1                                                                                                                                 |
| D09 | ordinary daemon freshness acknowledgement                  | undefined technical gate; проверить pinned version, доказать guard/rebuild или не выпускать accelerated state                                  |
| D10 | Old Host / unsupported platform                            | accepted; no false active state, baseline search available                                                                                     |

Questions for user: обязательных вопросов для подготовки прототипа нет. Delivery, parity и freshness gates требуют технического доказательства, а не пользовательского расследования. Новую продуктовую уступку корректности нельзя принять без отдельного согласования.

## План реализации — пять последовательных этапов

Сначала создать `docs/runtime-tools/tgrep-indexed-agent-search.md` как нормативный контракт. Этот план остаётся порядком выполнения и журналом доказательств; не копировать туда весь контракт второй раз. В существующем native-search spec сохранить startup-only правила bfs/ugrep и описать ссылку на отдельную live policy.

### 1. Спецификация и техническая квалификация

Обновить соответствующий native-search spec до изменения поведения; приложить case catalog/matrix. Перед кодом выполнить architecture baseline и bounded context целевых модулей. Проверить pin/platform resources, rg/BRE boundary, hot policy propagation, ordinary lifecycle и freshness gate. Измерить tgrep против **встроенного ugrep и rg** на реальных запросах, включая новые и повторные запросы, content/context, холодный и тёплый кеш.

Выход: выбранный проверяемый contract, список ускоряемых запросов, release target matrix. Сохранить spike sources, команды, версии, fixtures и машинно проверяемые результаты в репозитории; временный вывод этого чата их не заменяет. Если freshness, Bash admission или bridge не решены, этапы активации ready не начинать.

### 2. Встроенная доставка без зависимости от компьютера пользователя

Добавить ресурс в registry, preparation, notices, package/remote manifests и resolver. Qualification version/arch/hash — до публикации ресурса. Системный PATH не менять. Remote prepare не превращать отсутствие необязательного ускорителя в отказ всего подключения; состояние unavailable явное. Packaged clean machine/offline — обязательные проверки.

Выход: ZCode на поддерживаемых targets предоставляет собственный бинарник; missing/corrupt resource безопасно диагностируется в runtime, а некорректный release package отклоняется packaging gate.

### 3. Управляющий owner и совместимый поиск

Реализовать manager/port, persisted intent, статус/revision, per-request rg router, контекстные инструкции и общий freshness guard. Подключить обычный fallback и cancellation. Создать unit/contract tests до behavioral code, включая output parity и read-after-write. Structured FileSystemPort оставить baseline в первом выпуске; подключать лишь когда это необходимо для согласованного охвата и доказана parity, не блокировать Bash-first фичу расширением всех secondary paths.

Выход: ускорение работает через один механизм, один индексатор обслуживает readers workspace, сбои не ломают поиск, результаты не дублируются.

### 4. Переключатель и recovery

Добавить workspace-scoped UI через hooks/services, strict protocol/runtime validation, локализацию и доступность. Применение следующих запросов без restart session; текущее tool execution сохраняет корректный lifecycle. Mobile/Web используют существующий attachment. Off во время подготовки отменяет только принадлежащую активацию; поздний completion старой revision не включает функцию обратно.

Выход: один переключатель на чистой машине активирует ready после подготовки; при fallback понятно, почему tgrep не используется.

### 5. Приёмка и выпуск opt-in

Выполнить ниже перечисленные сценарии, target qualification и измерения. Обязательны pnpm typecheck и pnpm lint с реальными результатами; relevant unit/contracts, format и architecture checks. E2E выполняются через текущий desktop runner после review cases/fixtures, без выдуманных flags. Полный automatic default не включать.

Выход: доказательства установки/работы, совместимости, свежести, recovery и performance; только затем готовность opt-in фичи к выпуску. Commit/push/PR/deploy в рамках этого плана автоматически не разрешены.

## Точки входа в текущий код

Пути ниже относительны корню checkout. Они проверены при подготовке; при drift искать символ, а не восстанавливать удалённый файл. Новые методы, env keys и файлы gateway/manager вводить только после spec и architecture context.

| Участок                  | Читать / менять по необходимости                                                                                                                                                                                                                          | Конкретная задача                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Текущая политика поиска  | `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`; `core/src/runtime/methods/embedded-search-branch.ts` внутри того же CLI tree                                                                                                            | Сохранить Grep/Glob filtering; не включать скрытый tool ради маршрутизации                                                                                            |
| Admission и execution DI | `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`; `core/src/tool/handlers/bash.ts`; `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`                                                                                   | Живой search port, writer admission до эффекта; сохранить permissions/sandbox/output/cancellation                                                                     |
| Write boundaries         | `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`, `edit.ts`, `apply-patch.ts`; execution/file IO ports                                                                                                                                           | Invalidate до записи, включая partial failure; проверить workflow и background IO, не ограничиваться UI edits                                                         |
| Shell и bridge           | `apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`; `apps/zcode-cli/packages/cli/src/internal-search/embedded-search-cli.ts`                                                                                                          | Проверить существующий entry, поддерживаемые shell; не менять command string заменой `rg` на `tgrep`                                                                  |
| Composition и teardown   | `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`, `app/types.ts`, `app/embedded-search-backend.ts`; `zcode-protocol/runtime-resources.ts`, `zcode-protocol/server.ts` внутри bootstrap                                                           | Inject одного manager в все app/runtime instances Agent; explicit close. Standalone CLI composition тоже освобождает owner, не рассчитывает на protocol-only shutdown |
| Host service и настройки | `packages/services/src/zcode-agent/zcodeAgentService.ts`; `packages/services/src/setting/settingService.ts`; `packages/services/src/node.ts`                                                                                                              | Workspace preference authority, горячая доставка, статус existing runtime без пробуждения; текущий `syncAppRuntimePreferences` не считать workspace search API        |
| Протокол                 | `packages/shared/src/zcode-protocol/index.ts`; `packages/shared/src/zcode-protocol-v4/workspace-config.ts`; bootstrap `zcode-protocol-v4/workspace-config-publisher.ts`                                                                                   | Strict schemas, capability negotiation, status snapshot/revision; operational phase не прятать в `configOptions` без контракта                                        |
| UI target и storage      | `packages/ui/src/SettingsPage.tsx`; `packages/ui/src/hooks/useSettingService.ts`; `packages/ui/src/hooks/useWorkspaceServices.tsx`; `packages/shared/src/validationAppSettings.ts`                                                                        | Использовать workspace routing/authority; новый boolean не добавлять как глобальный sibling startup flag; pending привязан к target/revision                          |
| Bundled resources        | `packages/shared/src/runtime-tool-runtime.ts`; `packages/services/src/runtime-tools/runtimeToolResolver.ts`, `runtimeCommandEnv.ts`; `scripts/native-search-tools-config.mjs`, `prepare-native-search-tools.mjs`, `remote-native-search-tools-config.mjs` | Pinned optional tool: target mapping, hashes/notices, абсолютный путь; отсутствие необязательного бинарника не ломает Host startup                                    |
| Secondary baseline       | `apps/zcode-cli/packages/adapters/src/fs/index.ts`; bootstrap `app/workflow-world-read.ts`, `app/script-workflow-child-runtime.ts`                                                                                                                        | Проверить охват, оставить нынешний поиск работоспособным; не заявлять accelerated coverage этих путей в Bash-first v1                                                 |

Предлагаемые новые компоненты: typed indexed-search port в CLI contracts, manager в bootstrap, process/transport adapter в adapters. Shared хранит лишь протокол и DTO. Точные filenames выбрать по conventions; не создавать новую package или Service→Runtime import. Персистентный workspace intent интегрировать в существующий SettingService storage после проверки миграции. Очистка индекса — user-cache IO adapter, а не UI file operation.

## Проверки: команды и соответствие этапам

Запускать из корня через RTK, как требует окружение; команды используют текущие manifests. Если checkout изменился, сначала перепроверить scripts/package names. Команды ниже не заменяют написание новых тестов TG01–TG14.

```bash
rtk proxy node scripts/check-workspace-freshness.mjs
rtk git status --short
rtk proxy mise exec -- node --version
rtk proxy mise exec -- pnpm --version
```

При отсутствующих зависимостях — `rtk proxy mise run install`, затем при необходимости `rtk proxy mise run bootstrap`. Не запускать установку системного tgrep. Перед behavioral code:

```bash
rtk proxy mise exec -- pnpm architecture:check --changed
rtk proxy mise exec -- pnpm architecture:context zcode-cli
rtk proxy mise exec -- pnpm architecture:context services
rtk proxy mise exec -- pnpm architecture:context shared
```

Для этапов 2–3 исходные regression suites:

```bash
rtk proxy mise exec -- pnpm --filter @zcode/adapters exec vitest run tests/embedded-search-prelude.test.ts tests/fs-context.test.ts
rtk proxy mise exec -- pnpm --filter @zcode/core exec vitest run tests/embedded-search-shell.test.ts tests/runtime-embedded-search-capability.test.ts tests/runtime-tool-allowlist.test.ts
rtk proxy mise exec -- pnpm --filter @zcode/bootstrap exec vitest run tests/embedded-search-backend.test.ts
rtk proxy mise exec -- pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/internal-search.node-test.ts tests/sea-runtime-tools.test.ts
rtk proxy mise exec -- pnpm exec vitest run packages/services/test/runtimeToolResolver.test.ts packages/services/test/settingService.test.ts
```

Новые tests должны покрыть manager/epoch/bridge отдельно от этих regression suites; добавлять команды в журнал по мере появления реальных файлов. Для routing UI/Host также проверить `packages/services/test/zcodeAgentService.test.ts`, `zcodeAgentService.v4.test.ts`, `zcodeAgentProcessManager.test.ts` и `packages/ui/test/settingsWorkspaceServiceRouting.test.ts`, `settingsPageConfig.test.ts`. Root Vitest сам выбирает изолированный pool по своей конфигурации; не запускать эти тесты конфигурацией CLI.

Перед итоговым handoff:

```bash
rtk proxy mise exec -- pnpm typecheck
rtk proxy mise exec -- pnpm lint
rtk proxy mise exec -- pnpm --filter @zcode/contracts --filter @zcode/adapters --filter @zcode/core --filter @zcode/bootstrap --filter @zcode/cli run typecheck
rtk proxy mise exec -- pnpm --filter @zcode/contracts --filter @zcode/adapters --filter @zcode/core --filter @zcode/bootstrap --filter @zcode/cli run lint
rtk proxy mise exec -- pnpm fmt:check
rtk proxy mise exec -- pnpm architecture:check --changed
rtk git diff --check
```

Для delivery regression существуют `pnpm test:native-search:e2e` и `pnpm test:sea-runtime-tools:e2e`; сначала изучить runner/resources, затем расширить их tgrep-проверками, иначе успешный старый suite не доказывает новый ресурс. UI interaction cases вести через `.agents/skills/e2e-case-lifecycle/SKILL.md` и текущий desktop runner. Ручной dev запуск — `pnpm dev:desktop:test` с изолированными данными; обычный `dev:desktop` не считать тестовой средой. Не подключать реальную модель для deterministic search fixtures.

## Gates и доказательства завершения

Все строки сейчас **не выполнены**. Каждую закрывать ссылкой на fixture/test и сохранённый результат, а не устным «работает».

| Gate                   | Условие закрытия                                                                                                                                         | Если не выполнено                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| G1 Freshness / D09     | Immediate read-after-write, частичные совпадения, concurrent writer, external edits с сохранёнными mtime/size; доказанный publication/admission contract | Записать failing case; indexed ready не выпускать. Полный scan как проверка должен войти в performance measurement |
| G2 Shell / bridge      | Pure rg допускается без self-invalidation; compound/background writer не обходят guard; live on/off, argv/stdin/exit/cancel preserved                    | Сузить allowlist либо прекратить выбранную схему; не делать regex rewrite shell                                    |
| G3 Corpus / semantics  | Allowed queries совпадают с фактическим прежним backend на files/content/exit/error; различия фильтров явно обходятся                                    | Конкретный несовместимый запрос baseline; не объявлять весь tgrep совместимым                                      |
| G4 Package / lifecycle | Пакет без PATH tgrep офлайн активируется; target build, remote delivery, cache/process isolation, shutdown/recovery проверены                            | Target unavailable или исключён из release matrix; нет системной установки как обхода                              |
| G5 Product / benefit   | TG UI/recovery доказаны; измерены actual engine и search latency, build/cache/CPU/RAM на реальном allowlist и fallback mix                               | Не включать default; зафиксировать вывод о полезности и ограничениях                                               |

G3 сравнивает file sets без предположения о порядке, если исходный rg не обещает order; explicit sort, byte/line offsets, JSON records, stdout/stderr и exit проверяются отдельно. Фильтрация corpus должна быть одинаковой на build/serve/query. Файлы, исключённые tgrep по расширению или decode policy, нельзя просто удалить из ожидаемого результата.

G5 требует доказать **индекс**, а не только `via server`: сохранить backend choice и generation/admission evidence; на narrowing query проверить реальные candidate/index stats pinned build. Полное сканирование внутри tgrep не выдавать за индексированное ускорение. Логи engine proof нужны тестам/diagnostics, не раскрывают query или file content пользователю.

Benchmark harness запускает фактический gateway и fallback executable; фиксирует version/OS/arch, corpus/filters, cold/warm режим, число повторов, median/p95, output volume и fallback share. Добавить сценарий «поиск после каждой правки»: выигрыш только на неподвижном прогретом corpus недостаточен для агента. Порог полезности и resource budget закрепить по spike **до** финального замера; не подбирать их после результата. Успех G5 — воспроизводимый выигрыш сверх разброса измерений на целевых запросах, без неприемлемого ухудшения обычного пути и потребления ресурсов.

## Журнал передачи следующему исполнителю

Текущее состояние: только этот план и ссылка в native-search spec; нет реализации, новых tests или qualified release assets. Этап 1 — следующий. Все TG cases имеют статус `planned`, все gates открыты. Existing local tgrep и временные benchmark результаты не использовать как release evidence.

Проверка handoff при подготовке: 3 относительные документные ссылки и 22 полных source paths существуют; manifest scripts пяти CLI packages проверены; Markdown fences сбалансированы; `git diff --check` без ошибок. `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check` завершились ошибкой запуска: отсутствуют `node_modules` и соответственно `tsc`, `oxlint`, `oxfmt`. Это document sanity check, не выполненные TG cases и не проверенный продукт.

После работы заполнить одну компактную запись: `этап → решение → изменённые файлы → commands/results → незакрытый gate → следующий шаг`. На техническом stop gate сохранить минимальное воспроизведение и причину; не заменять критерий корректности без согласования. Незапущенные проверки писать как `not run` с причиной, baseline failures — отдельно.

Текст для запуска нового чата:

> Реализуй opt-in индексированный поиск агента по docs/plan/2026-10-10-tgrep-indexed-agent-search.md в текущем ZCode checkout. Начни с AGENTS, freshness/baseline и этапа 1: spec и доказательство freshness, Bash admission, bridge и pin/platform qualification. tgrep должен поставляться с ZCode; системная установка не требуется. Default off; отдельная workspace live policy, существующий bfs/ugrep startup flag сохраняет семантику. Нельзя считать ready по async watcher/status или таймеру; если gate не проходит, сохрани воспроизводимое доказательство и останови indexed активацию. Все изменения проверяй соответствующими root и CLI package suites. Сохрани чужой diff. Commit, push, PR, публикация и новая production dependency без отдельного согласования не разрешены. Обновляй журнал в плане, чтобы следующая сессия продолжила с последнего доказанного этапа.

## Accepted Cases / Coverage Matrix

| Case ID | Setup                                                                                  | Action                                                                 | Assertions                                                                                   | Evidence / E2E                                    |
| ------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| TG01    | Fresh packaged desktop; tgrep absent from PATH; сеть отключена                         | Включить для проекта и выполнить поиск                                 | Собственный бинарник, статус ready, engine=tgrep, точный результат                           | Package + UI + process; planned                   |
| TG02    | tgrep absent/corrupt/wrong arch                                                        | Включить и искать                                                      | Не false-active, обычный результат, понятная ошибка, bounded retry                           | Resource unit + runtime + UI; planned             |
| TG03    | Off/on обоих search switches                                                           | Выполнить find, grep, rg                                               | Старый switch сохраняет семантику; tgrep routing независим                                   | 2x2 contract + shell; planned                     |
| TG04    | Индекс строится или disk/cache write failure                                           | Искать, затем выключить                                                | Нет ожидания build, baseline работает; stale completion не активирует                        | Timing fake + filesystem + UI; planned            |
| TG05    | Пустые/непустые результаты, новые/удалённые файлы                                      | Write/Edit/ApplyPatch/Bash/rename -> immediate search                  | Ни false negative, ни пропущенного дополнительного совпадения                                | Controlled mutation gate + parity; planned        |
| TG06    | External editor, git checkout, ignore change, watcher overflow/polling                 | Изменить root/corpus и искать                                          | Dirty/unknown обслуживается baseline, no timer-based readiness                               | Native fixture + gated events; planned            |
| TG07    | Сессии A/B и Explore одного workspace                                                  | A изменяет; B/Explore сразу ищут                                       | Общая invalidation, правильный результат, один owned daemon                                  | Multi-runtime/process + E2E; planned              |
| TG08    | Два worktree; одинаковые paths разных remote Hosts; два Agent на одном физическом root | Искать/включать/выключать; другой процесс пишет                        | Identity не смешивается; свой daemon/cache; external freshness proof либо qualification fail | Identity + independent-process fixtures; planned  |
| TG09    | SSH/WSL/Docker; mobile existing attachment                                             | Включить; reconnect; повторить status                                  | Бинарник/root на execution machine; нет второго Agent; latest status                         | Remote + replayable E2E; planned                  |
| TG10    | Native/pinned parity corpus                                                            | Literals/regex/i/glob/type/context/count/JSON/CRLF/Unicode/PDF/symlink | Только доказанно совместимые запросы ускоряются; остальные exact fallback                    | Golden normalized results + native tools; planned |
| TG11    | Input pipeline, missing path, deny, invalid regex, cancellation                        | Выполнить rg и отменить                                                | stdin/exit/error/permissions preserved, без частичного дублирования                          | Shell/permission contracts; planned               |
| TG12    | Daemon crash/OOM, app restart/update, old Host                                         | Искать и восстановить                                                  | Поиск доступен, incompatible cache не ready, no restart loop                                 | Fault/recovery + package E2E; planned             |
| TG13    | Закрытие одной из нескольких сессий, off, root move/remove                             | Завершить usage и cleanup                                              | Нет orphan owned process; не убит чужой процесс; Windows handles released                    | Owned-process assertions; planned                 |
| TG14    | Existing active chat + target switch + delayed reply                                   | Toggle on/off и следующий model/search step                            | Настройка действует без restart; stale reply не перезаписывает новый target                  | UI + protocol + runtime; planned                  |

## Planning Handoff / Matrix Backfill / E2E Handoff Notes

| Item                  | Destination                                                                  | Status                               |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Spec update           | Embedded Search Native Build + новый indexed-search contract                 | planned before code                  |
| Case catalog / matrix | TG01–TG14 выше; затем отдельный testing doc при реализации                   | planning complete; execution missing |
| Decision backlog      | D09 freshness; platform/packaging qualification; exact new service interface | technical gates open                 |
| Feature graph         | Расширение capability.embedded-native-search подтверждённой схемой           | proposed; не выдавать draft за факт  |
| E2E handoff           | e2e-case-lifecycle, reviewed isolated cases                                  | planned; CI admission отсутствует    |

Provider fixture: scripted search/mutation calls без расхода на реальные модели. File-system fixture: отдельный временный Git root, два worktree, бинарные/Unicode/CRLF/ignore случаи. Timing strategy: barriers/fake lifecycle для deterministic tests; отдельные native watcher tests с bounded deadlines и engine proof. Docker preset: выбрать существующий preset после inventory, имя не выдумывать. Windows arm64 static qualification не обозначать как native runtime E2E.

Существующие тестовые отправные точки: runtimeToolResolver, embedded-search-prelude, embedded-search-shell, runtime-embedded-search-capability, fs-context. CLI **core/adapters/bootstrap** используют Vitest; package **cli** использует `node:test` через tsx, включая internal-search и SEA tests. Root Vitest и root typecheck не охватывают CLI packages полностью: отдельные проверки обязательны. Desktop E2E — текущий desktop runner. Параметры запуска уточнять по manifest/help непосредственно перед запуском.

## Измерения и доказательства

Ранее в этом чате на macOS arm64 / ZCode измерены восемь запросов, семь повторов каждого движка после прогрева. tgrep 1.1.0 использовал ordinary server, filenames-only, --hidden, без max-filesize limit. В семи запросах совпали file sets; speedup против native rg — 8,6–18,3x. Восьмой разошёлся на PDF; это не доказательство production parity или ускорения относительно ugrep. Индекс: 16751 файлов, около 161 МиБ; начальный build около 1,1 с. Raw fixtures/cache временные, не committed и не считаются будущей release evidence.

Performance gate: измерить общий поиск агента против текущего backend, индексирование, startup, idle/churn CPU/RAM, storage и один/несколько workspace. Учитывать broad patterns без триграмм, cache hits и fallback frequency. Не обещать ускорение model latency или сокращение токенов.

## Источники

- [Upstream release v1.1.0](https://github.com/microsoft/tgrep/releases/tag/v1.1.0): опубликованные target archives; runtime qualification ещё требуется.
- [README pinned v1.1.0](https://github.com/microsoft/tgrep/blob/v1.1.0/README.md): проверять возможности кандидата по tag; server readiness/transport не доказывают freshness/index narrowing.
- [README tgrep](https://github.com/microsoft/tgrep#readme): индекс, asynchronous freshness, CLI compatibility и shared mode.
- [Бенчмарки tgrep](https://github.com/microsoft/tgrep/blob/main/BENCHMARKS.md): ready-index latency, отдельно от initial indexing.
- [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference): пример автоматического выбора, не контракт ZCode.
- [Текущая спецификация native search](../runtime-tools/embedded-search-native-build.md).
- [Runtime delivery](../runtime-tools/ripgrep-runtime.md).
- [Feature Impact Discovery](../feature-impact-discovery.md).

## Журнал выполнения

### Этап 1 — спецификация и техническая квалификация (2026-10-11)

Исполнитель: ZCode-сессия. Checkout: новый worktree `feat/tgrep-indexed-search-stage1` от `origin/integration` `b878895b` (PR #21 уже влит; исходный `40de77e4` — его предок). План-документ перенесён из codex-worktree 8f42 (там оставлен нетронутым).

**Решение.** Gate D09 закрыт механически: единственный квалифицируемый режим — shared repository daemon (`serve --shared <root> --shared-storage <внешний кеш>` + `shared attach/refresh/detach`). `refresh --changed` возвращает `processed_epoch` — доказуемый read-after-write (S1 25/25, S1b/S1c/S1M pass). Обычный `serve` не имеет явного refresh-подтверждения (O1: 24/25 immediate miss, видимость 47–67 мс; O2: `--no-watch` — перманентный stale) и запрещён для ускоренного состояния. `--no-watch` в продукте запрещён: S2 показал false-ready на внешней same-size/restored-mtime правке (восстанавливает только `refresh --full`, ~543 мс на 6k файлов); native watch закрывает readiness за ~21 мс, и в окне закрытия запрос корректен (scan-fallback, S3). Worktree-изоляция view подтверждена (S4). Контракт зафиксирован в `docs/runtime-tools/tgrep-indexed-agent-search.md`.

**G5-решение (главный результат).** Производительность на прогретом индексе НЕ подтверждена для целевого сценария: селективные запросы выигрывают (rare-literal 4.7x на 12k → 15x на 50k файлов), но широкие запросы (`function`, -l, -c, broad regex) медленнее bundled rg в 4.4–7.6x, а доминирующий для агента цикл «правка → поиск» медленнее в 6.2–6.9x (`refresh --changed` растёт с размером репо: 272 мс @6k → ~2.2 с @50k). Вывод прошлого исследования (8.6–18.3x) получен на узком подмножестве (filenames-only, без учёта свежести) и как продуктовое основание отклонён. Parity-превью: сортированный вывод и exit-коды tgrep совпали с rg 8/8 паттернов на 12k и 50k.

**Изменённые файлы.** `docs/runtime-tools/tgrep-indexed-agent-search.md` (новый нормативный контракт); `docs/runtime-tools/embedded-search-native-build.md` (+ссылка на план/контракт, семантика bfs/ugrep не тронута); `docs/runtime-tools/spikes/tgrep-v1.1.0-stage1/{README.md,results/freshness-darwin-arm64.json,results/benchmark-darwin-arm64.json,results/benchmark-darwin-arm64-large.json}`; `scripts/tgrep-stage1/{run-freshness.mjs,run-benchmark.mjs,lib/corpus.mjs,lib/tools.mjs,lib/proc.mjs}`; этот план.

**Команды/результаты.** `node scripts/tgrep-stage1/run-freshness.mjs` — все S-тесты pass, gates.D09_shared_acknowledged_freshness=proven-on-pinned-build; `node scripts/tgrep-stage1/run-benchmark.mjs` и `--files 50000 --reps 5` — parity 8/8, цифры в README спайка. `pnpm typecheck` — pass; `pnpm lint` — 0 errors (62 предсуществующих warnings, в новых файлах 0); `pnpm architecture:check` — violations: 0; `pnpm exec oxfmt` по изменённым файлам — pass (репо-широкий `fmt:check` имеет предсуществующий дрейф ~1800 файлов, CI проверяет только изменённые). `pnpm test` — см. статус PR-проверок. tgrep-архив darwin-arm64 скачан и сверен с pinned SHA-256; rg/ugrep взяты из репозиторных архивов.

**Незакрытые gates.** G2 (Bash admission/bridge — только контракт, реализации нет); G3 (полный TG10-corpus: превью 8/8, но corpus ограничен utf-8/CRLF/binary-фильтрами и не покрывает PDF/PCRE2/JSON/Unicode); G4 (доставка: только darwin-arm64 проверен исполнением, SHA всех 6 архивов зафиксированы, PE/musl/minos-проверки не выполнялись); **G5 (стоп-gate: ускорение после правок и широкие запросы проигрывают baseline; положительное измерение на целевом масштабе отсутствует)**.

**Следующий шаг.** Продуктовое решение владельца: (a) остановить реализацию — техническая механика свежести доказана, но польза не доказана, ускорение широких запросов и цикла правок отрицательно; или (b) продолжить этап 2 только после получения положительного G5-измерения (например, лог-запись реальных запросов агента на целевых репо и повторный замер только селективного подмножества с политикой routing «ускорять только селективные запросы на стационарном корпусе»). Этапы 2–5 без этого решения не начинать.
