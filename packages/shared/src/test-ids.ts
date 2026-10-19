/* eslint-disable max-lines -- the testid registry keeps growing with features as a single source; splitting it would break "one place to look". */
/**
 * Centralized registry of all data-testid values, shared by UI components and E2E tests.
 * Add new test IDs here instead of hard-coding strings in components.
 * Each entry must have an English comment.
 */

// Login entry
/** Top-right login trigger button. */
export const TID_LOGIN_TRIGGER = "login-trigger";
/** Login action in the user menu. */
export const TID_LOGIN_MENU_ITEM = "login-menu-item";
/** Button to switch to API Key login on the login page. */
export const TID_LOGIN_USE_API_KEY_BUTTON = "login-use-api-key-button";
/** API Key login provider-selection trigger. */
export const TID_LOGIN_API_KEY_PROVIDER_TRIGGER = "login-api-key-provider-trigger";
/** API Key login provider choice (dynamic suffix is the provider choice). */
export const TID_LOGIN_API_KEY_PROVIDER_ITEM = "login-api-key-provider-item";
/** API Key login key input. */
export const TID_LOGIN_API_KEY_INPUT = "login-api-key-input";
/** API Key login continue button. */
export const TID_LOGIN_API_KEY_CONTINUE_BUTTON = "login-api-key-continue-button";
/** API Key login cancel button. */
export const TID_LOGIN_API_KEY_CANCEL_BUTTON = "login-api-key-cancel-button";
/** API Key login skip-for-now button. */
export const TID_LOGIN_API_KEY_SKIP_BUTTON = "login-api-key-skip-button";
/** API Key login error message. */
export const TID_LOGIN_API_KEY_ERROR = "login-api-key-error";
/** Login button in the OAuth dialog. */
export const TID_OAUTH_LOGIN_BUTTON = "oauth-login-button";
/** OAuth dialog cancel button. */
export const TID_OAUTH_CANCEL = "oauth-cancel";
/** OAuth error text. */
export const TID_OAUTH_ERROR = "oauth-error";

// Assistant code comments
/** Toggle button that expands or collapses all AI code-review cards. */
export const TID_ASSISTANT_CODE_COMMENT_TOGGLE = "assistant-code-comment-toggle";
/** AI code-review item in the code review pane. */
export const TID_ASSISTANT_CODE_COMMENT_ITEM = "assistant-code-comment-item";

// App
/** Top navigation bar. */
export const TID_APP_HEADER = "app-header";
/** Language toggle button. */
export const TID_LOCALE_TOGGLE = "locale-toggle";
/** Theme toggle button. */
export const TID_THEME_TOGGLE = "theme-toggle";
/** Log out button. */
export const TID_LOGOUT_BUTTON = "logout-button";
/** Terminal visibility toggle button. */
export const TID_TERMINAL_TOGGLE = "terminal-toggle";
export const TID_SIDE_PANE_TOGGLE = "side-pane-toggle";
/** Terminal panel close button. */
export const TID_TERMINAL_CLOSE_BUTTON = "terminal-close-button";
/** Browser visibility toggle button. */
export const TID_BROWSER_TOGGLE = "browser-toggle";
/** Git visibility toggle button. */
export const TID_GIT_TOGGLE = "git-toggle";
/** Browser panel container. */
export const TID_BROWSER_PANE = "browser-pane";
/** Browser panel close button. */
export const TID_BROWSER_CLOSE_BUTTON = "browser-close-button";
/** Git panel container. */
export const TID_GIT_PANE = "git-pane";
/** Git panel close button. */
export const TID_GIT_CLOSE_BUTTON = "git-close-button";
/** Main entry point for Git commit or push in the top bar. */
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
/** Git commit dialog. */
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
/** Git commit message input. */
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
/** Git commit message generation button. */
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
/** Toggle to include unstaged changes in the Git commit dialog. */
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
/** Command action list at the bottom of the Git commit dialog. */
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
/** Action item at the bottom of the Git commit dialog (dynamic suffix is the action ID). */
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
/** Browser address-bar input. */
export const TID_BROWSER_ADDRESS_INPUT = "browser-address-input";
/** Browser back button. */
export const TID_BROWSER_BACK_BUTTON = "browser-back-button";
/** Browser forward button. */
export const TID_BROWSER_FORWARD_BUTTON = "browser-forward-button";
/** Browser refresh button. */
export const TID_BROWSER_REFRESH_BUTTON = "browser-refresh-button";
/** Browser free-size mode button. */
export const TID_BROWSER_RESPONSIVE_BUTTON = "browser-responsive-button";
/** Browser free-size viewport. */
export const TID_BROWSER_RESPONSIVE_VIEWPORT = "browser-responsive-viewport";
/** Browser free-size top control bar. */
export const TID_BROWSER_RESPONSIVE_TOOLBAR = "browser-responsive-toolbar";
/** Browser free-size width input. */
export const TID_BROWSER_RESPONSIVE_WIDTH_INPUT = "browser-responsive-width-input";
/** Browser free-size height input. */
export const TID_BROWSER_RESPONSIVE_HEIGHT_INPUT = "browser-responsive-height-input";
/** Browser free-size zoom selector. */
export const TID_BROWSER_RESPONSIVE_ZOOM_SELECT = "browser-responsive-zoom-select";
/** Browser free-size zoom option (dynamic suffix is the zoom value). */
export const TID_BROWSER_RESPONSIVE_ZOOM_OPTION = "browser-responsive-zoom-option";
/** Canvas placeholder after browser free-size zoom. */
export const TID_BROWSER_RESPONSIVE_SCALED_FRAME = "browser-responsive-scaled-frame";
/** Browser free-size left resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_LEFT = "browser-responsive-resize-left";
/** Browser free-size right resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_WIDTH = "browser-responsive-resize-width";
/** Browser free-size top resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_TOP = "browser-responsive-resize-top";
/** Browser free-size bottom resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_HEIGHT = "browser-responsive-resize-height";
/** Browser free-size top-left resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_LEFT =
  "browser-responsive-resize-corner-top-left";
/** Browser free-size top-right resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_TOP_RIGHT =
  "browser-responsive-resize-corner-top-right";
/** Browser free-size bottom-left resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER_BOTTOM_LEFT =
  "browser-responsive-resize-corner-bottom-left";
/** Browser free-size bottom-right resize handle. */
export const TID_BROWSER_RESPONSIVE_RESIZE_CORNER = "browser-responsive-resize-corner";
/** Browser web-element selection button. */
export const TID_BROWSER_ELEMENT_PICKER_BUTTON = "browser-element-picker-button";
/** Browser address-bar more-actions button. */
export const TID_BROWSER_MORE_BUTTON = "browser-more-button";
/** Browser menu item to open the page in the default browser. */
export const TID_BROWSER_OPEN_EXTERNAL_ITEM = "browser-open-external-item";
/** Browser developer-tools button. */
export const TID_BROWSER_DEVTOOLS_BUTTON = "browser-devtools-button";
/** Browser web view. */
export const TID_BROWSER_WEBVIEW = "browser-webview";
/** Built-in browser permission prompt bar container. */
export const TID_BROWSER_PERMISSION_PROMPTS = "browser-permission-prompts";
/** Permission bar "allow just this once" button. */
export const TID_BROWSER_PERMISSION_ALLOW_ONCE = "browser-permission-allow-once";
/** Permission bar "always allow for this site" button. */
export const TID_BROWSER_PERMISSION_ALLOW_ALWAYS = "browser-permission-allow-always";
/** Permission bar "deny" button (deny this time, do not remember). */
export const TID_BROWSER_PERMISSION_DENY = "browser-permission-deny";
export const TID_BROWSER_PERMISSION_DISMISS = "browser-permission-dismiss";
/** Browser guest-failure retry button. */
export const TID_BROWSER_GUEST_RETRY = "browser-guest-retry";
/** Readable error state when a browser page fails to load. */
export const TID_BROWSER_LOAD_ERROR = "browser-load-error";
/** Certificate-bypass guidance in the browser load-failure state. */
export const TID_BROWSER_LOAD_ERROR_CERT_HINT = "browser-load-error-cert-hint";
/** Preview panel container. */
export const TID_PREVIEW_PANE = "preview-pane";
/** Preview panel close button. */
export const TID_PREVIEW_CLOSE_BUTTON = "preview-close-button";
/** Preview panel previous-segment button. */
export const TID_PREVIEW_PREV_BUTTON = "preview-prev-button";
/** Preview panel next-segment button. */
export const TID_PREVIEW_NEXT_BUTTON = "preview-next-button";
/** "View code" button in a tool call. */
export const TID_TOOL_CODE_VIEWER_BUTTON = "tool-code-viewer-button";
/** Trigger button in a tool-call summary row (dynamic suffix is toolId). */
export const TID_TOOL_SUMMARY_TRIGGER = "tool-summary-trigger";

// Voice dictation
/** Voice dictation language-picker trigger. */
export const TID_VOICE_LANGUAGE_TRIGGER = "voice-language-trigger";
/** Voice dictation language-picker search input. */
export const TID_VOICE_LANGUAGE_SEARCH = "voice-language-search";
/** Voice dictation language option checkbox (dynamic suffix is the language code). */
export const TID_VOICE_LANGUAGE_OPTION = "voice-language-option";
/** Voice dictation language-picker empty-results state. */
export const TID_VOICE_LANGUAGE_EMPTY = "voice-language-empty";
/** Voice dictation language-picker clear-selection button. */
export const TID_VOICE_LANGUAGE_CLEAR = "voice-language-clear";

// Terminal
/** Terminal container. */
export const TID_TERMINAL = "terminal";

// SSHDialog
/** Trigger button to open the SSH connection dialog. */
export const TID_SSH_CONNECT_TRIGGER = "ssh-connect-trigger";
/** SSH connection dialog container. */
export const TID_SSH_DIALOG = "ssh-dialog";
/** Switch remote connection type to SSH. */
export const TID_REMOTE_KIND_SSH = "remote-kind-ssh";
/** Switch remote connection type to Server. */
export const TID_REMOTE_KIND_SERVER = "remote-kind-server";
/** Switch remote connection type to WSL. */
export const TID_REMOTE_KIND_WSL = "remote-kind-wsl";
/** Switch remote connection type to Docker. */
export const TID_REMOTE_KIND_DOCKER = "remote-kind-docker";
/** SSH host address input. */
export const TID_SSH_HOST_INPUT = "ssh-host-input";
/** SSH port input. */
export const TID_SSH_PORT_INPUT = "ssh-port-input";
/** SSH username input. */
export const TID_SSH_USERNAME_INPUT = "ssh-username-input";
/** SSH config alias selector. */
export const TID_SSH_CONFIG_ALIAS_SELECT = "ssh-config-alias-select";
/** SSH password input. */
export const TID_SSH_PASSWORD_INPUT = "ssh-password-input";
/** SSH private-key path input. */
export const TID_SSH_PRIVATE_KEY_INPUT = "ssh-private-key-input";
/** SSH authentication method: password. */
export const TID_SSH_AUTH_PASSWORD = "ssh-auth-password";
/** SSH authentication method: private key. */
export const TID_SSH_AUTH_PRIVATE_KEY = "ssh-auth-private-key";
/** WSL distribution selector. */
export const TID_WSL_DISTRO_SELECT = "wsl-distro-select";
/** WSL Linux user input. */
export const TID_WSL_USER_INPUT = "wsl-user-input";
/** Docker container selector. */
export const TID_DOCKER_CONTAINER_SELECT = "docker-container-select";
/** Docker container name/ID input. */
export const TID_DOCKER_CONTAINER_INPUT = "docker-container-input";
/** Server remote service URL input. */
export const TID_SERVER_URL_INPUT = "server-url-input";
/** Server remote service name input. */
export const TID_SERVER_NAME_INPUT = "server-name-input";
/** Server remote service token input. */
export const TID_SERVER_TOKEN_INPUT = "server-token-input";
/** Server remote default workspace path input. */
export const TID_SERVER_WORKSPACE_PATH_INPUT = "server-workspace-path-input";
/** SSH connection confirmation button. */
export const TID_SSH_CONNECT_BUTTON = "ssh-connect-button";
/** SSH dialog cancel button. */
export const TID_SSH_CANCEL_BUTTON = "ssh-cancel-button";

// Sidebar
/** Sidebar container. */
export const TID_SIDEBAR = "sidebar";
/** Sidebar open-workspace button. */
export const TID_WORKSPACE_OPEN_BUTTON = "workspace-open-button";
/** Sidebar workspace list. */
export const TID_WORKSPACE_LIST = "workspace-list";
/** Sidebar workspace item (dynamic suffix is workspacePath). */
export const TID_WORKSPACE_ITEM = "workspace-item";
/** Sidebar close-workspace button (dynamic suffix is workspacePath). */
export const TID_WORKSPACE_CLOSE = "workspace-close";
/** Sidebar project row pin/unpin menu item (dynamic suffix is workspacePath). */
export const TID_WORKSPACE_TOGGLE_PIN = "workspace-toggle-pin";
/** Divider between pinned and unpinned projects in the sidebar workspace list. */
export const TID_WORKSPACE_PIN_DIVIDER = "workspace-pin-divider";
/** Conversation subsection in the project view. */
export const TID_CONVERSATION_SECTION = "conversation-section";
/** Project subsection in the project view. */
export const TID_PROJECT_SECTION = "project-section";
/** New-task button in the conversation section. */
export const TID_CONVERSATION_NEW_TASK = "conversation-new-task";
/** Add-menu button in the project section. */
export const TID_PROJECT_ADD = "project-add";
/** Composer workspace selection trigger. */
export const TID_COMPOSER_WORKSPACE_TRIGGER = "composer-workspace-trigger";
/** Remote-connection entry in the Composer workspace menu. */
export const TID_COMPOSER_REMOTE_CONNECTION = "composer-remote-connection";
/** Composer detach-current-project button. */
export const TID_COMPOSER_PROJECT_DETACH = "composer-project-detach";
/** Non-project work entry in the Composer workspace menu. */
export const TID_COMPOSER_WORK_OUTSIDE_PROJECT = "composer-work-outside-project";
// ChatView
/** Chat view container. */
export const TID_CHAT_VIEW = "chat-view";
/** Chat message list. */
export const TID_CHAT_MESSAGES = "chat-messages";
/** Error banner above the chat input. */
export const TID_CHAT_ERROR_BANNER = "chat-error-banner";
/** Details button for a Hook-blocking error. */
export const TID_CHAT_ERROR_DETAILS_BUTTON = "chat-error-details-button";
/** Icon at the left of the Hook-blocking error banner. */
export const TID_CHAT_ERROR_HOOK_ICON = "chat-error-hook-icon";
/** Chat empty-state container. */
export const TID_CHAT_EMPTY = "chat-empty";
/** Chat input. */
export const TID_CHAT_INPUT = "chat-input";
/** Chat attachment button. */
export const TID_CHAT_ATTACHMENT_BUTTON = "chat-attachment-button";
/** Chat attachment menu item. */
export const TID_CHAT_ATTACHMENT_MENU_ITEM = "chat-attachment-menu-item";
/** Chat send button. */
export const TID_CHAT_SEND_BUTTON = "chat-send-button";
/** Chat stop button. */
export const TID_CHAT_STOP_BUTTON = "chat-stop-button";
/** Chat loading indicator. */
export const TID_CHAT_LOADING = "chat-loading";
/** Chat status-summary panel in the upper-right corner. */
export const TID_CHAT_SUMMARY_PANEL = "chat-summary-panel";
/** Chat context-compaction timeline bar (dynamic suffix is inputId or operationId). */
export const TID_CHAT_COMPACT_MARKER = "chat-compact-marker";
/** Retry button after chat context compaction fails/is interrupted (dynamic suffix is inputId or operationId). */
export const TID_CHAT_COMPACT_RETRY_BUTTON = "chat-compact-retry-button";
/** Chat goal-verification timeline bar (dynamic suffix is targetId:goalIteration or verificationId). */
export const TID_CHAT_GOAL_VERIFICATION_MARKER = "chat-goal-verification-marker";
/** Chat queue panel. */
export const TID_CHAT_QUEUE_PANEL = "chat-queue-panel";
/** Chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_ITEM = "chat-queue-item";
/** Chat queue item content (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_ITEM_CONTENT = "chat-queue-item-content";
/** Send-now button for a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_SEND_NOW_BUTTON = "chat-queue-send-now-button";
/** Edit button for a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_EDIT_BUTTON = "chat-queue-edit-button";
/** Edit input for a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_EDIT_INPUT = "chat-queue-edit-input";
/** Save button for editing a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_EDIT_SAVE_BUTTON = "chat-queue-edit-save-button";
/** Cancel button for editing a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_EDIT_CANCEL_BUTTON = "chat-queue-edit-cancel-button";
/** Remove button for a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_REMOVE_BUTTON = "chat-queue-remove-button";
/** Drag handle for a chat queue item (dynamic suffix is queueItemId). */
export const TID_CHAT_QUEUE_DRAG_HANDLE = "chat-queue-drag-handle";
/** Chat user-message container (dynamic suffix is messageId). */
export const TID_CHAT_USER_MESSAGE = "chat-user-message";
/** Chat assistant-message container (dynamic suffix is messageId). */
export const TID_CHAT_ASSISTANT_MESSAGE = "chat-assistant-message";
/** Chat assistant-message history-collapse trigger (dynamic suffix is historyStateKey). */
export const TID_CHAT_ASSISTANT_HISTORY_TRIGGER = "chat-assistant-history-trigger";
/** Chat assistant-message history-collapse content (dynamic suffix is historyStateKey). */
export const TID_CHAT_ASSISTANT_HISTORY_CONTENT = "chat-assistant-history-content";
/** Task title for a standalone background result turn (dynamic suffix is the turn key). */
export const TID_CHAT_BACKGROUND_RESULT_TITLE = "chat-background-result-title";
/** Chat tool-call block container (dynamic suffix is toolCallId). */
export const TID_CHAT_TOOL_CALL_BLOCK = "chat-tool-call-block";
/** Edit button for a chat user message (dynamic suffix is messageId). */
export const TID_CHAT_MESSAGE_EDIT_BUTTON = "chat-message-edit-button";
/** Edit input for a chat user message (dynamic suffix is messageId). */
export const TID_CHAT_MESSAGE_EDIT_INPUT = "chat-message-edit-input";
/** Submit button for editing a chat user message (dynamic suffix is messageId). */
export const TID_CHAT_MESSAGE_EDIT_SUBMIT = "chat-message-edit-submit";
/** Cancel button for editing a chat user message (dynamic suffix is messageId). */
export const TID_CHAT_MESSAGE_EDIT_CANCEL = "chat-message-edit-cancel";
/** Fork button for a chat assistant message (dynamic suffix is messageId). */
export const TID_CHAT_MESSAGE_FORK_BUTTON = "chat-message-fork-button";
/** Undo/reapply button for a chat change summary (dynamic suffix is messageId). */
export const TID_CHAT_CHANGE_SUMMARY_TOGGLE_FILES_BUTTON =
  "chat-change-summary-toggle-files-button";
/** Chat input prefix-suggestion panel. */
export const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
/** Chat input prefix-suggestion group (dynamic suffix is the group ID). */
export const TID_PROMPT_SUGGESTION_SECTION = "prompt-suggestion-section";
/** Chat input prefix-suggestion option (dynamic suffix is the option ID). */
export const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
/** Chat input prefix-suggestion status row (dynamic suffix is the group ID). */
export const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";

// TaskList
/** Task list container. */
export const TID_TASK_LIST = "task-list";
/** New-task button. */
export const TID_TASK_NEW_BUTTON = "task-new-button";
/** Task-list item (dynamic suffix is taskId). */
export const TID_TASK_ITEM = "task-item";
/** Task-list empty state. */
export const TID_TASK_EMPTY = "task-empty";
/** Archive button for a task (dynamic suffix is taskId). */
export const TID_TASK_ARCHIVE = "task-archive";
/** Settings entry button below the task list. */
export const TID_TASK_SETTINGS_BUTTON = "task-settings-button";

// Settings
/** Settings page container. */
export const TID_SETTINGS_PAGE = "settings-page";
/** Settings-page return-to-workspace button. */
export const TID_SETTINGS_BACK_BUTTON = "settings-back-button";
/** Settings left-side section entry (dynamic suffix is the section ID). */
export const TID_SETTINGS_SECTION_NAV = "settings-section-nav";
/** Enhanced Find/Grep toggle in General Settings. */
export const TID_SETTINGS_NATIVE_SEARCH_SWITCH = "settings-native-search-switch";
/** Read-only data-storage path input in General Settings. */
export const TID_SETTINGS_DATA_BASE_DIR_INPUT = "settings-data-base-dir-input";
/** Data-storage path directory-picker button in General Settings. */
export const TID_SETTINGS_DATA_BASE_DIR_BROWSE = "settings-data-base-dir-browse";
/** Data-storage path save button in General Settings. */
export const TID_SETTINGS_DATA_BASE_DIR_SAVE = "settings-data-base-dir-save";
/** Data-storage path copy/restart-required/failure status in General Settings. */
export const TID_SETTINGS_DATA_BASE_DIR_STATUS = "settings-data-base-dir-status";
/** Resource-manager top tab (suffix=cpu|memory|storage). */
export const TID_RESOURCE_MANAGER_TAB = "resource-manager-tab";
/** Resource Manager "Storage" tab: section container. */
export const TID_RESOURCE_MANAGER_STORAGE_SECTION = "resource-manager-storage-section";
/** Resource Manager "Storage" tab: total usage number. */
export const TID_RESOURCE_MANAGER_STORAGE_TOTAL = "resource-manager-storage-total";
/** Resource Manager "Storage" tab: scan state (data-state=scanning|complete|cancelled|failed|idle). */
export const TID_RESOURCE_MANAGER_STORAGE_STATUS = "resource-manager-storage-status";
/** Resource Manager "Storage" tab: rescan button. */
export const TID_RESOURCE_MANAGER_STORAGE_RESCAN = "resource-manager-storage-rescan";
/** Resource Manager "Storage" tab: disk card (suffix is the volume key index). */
export const TID_RESOURCE_MANAGER_STORAGE_DISK_CARD = "resource-manager-storage-disk-card";
/** Resource Manager "Storage" tab: root-directory row in a disk card (suffix=rootId). */
export const TID_RESOURCE_MANAGER_STORAGE_ROOT = "resource-manager-storage-root";
/** Resource Manager "Storage" tab: category row (suffix=categoryId). */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_ROW = "resource-manager-storage-category-row";
/** Resource Manager "Storage" tab: category-row size (suffix=categoryId). */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_SIZE = "resource-manager-storage-category-size";
/** Resource Manager "Storage" tab: category cleanup button (suffix=categoryId). */
export const TID_RESOURCE_MANAGER_STORAGE_CATEGORY_CLEAN =
  "resource-manager-storage-category-clean";
/** Resource Manager "Storage" tab: category detail view. */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL = "resource-manager-storage-detail";
/** Resource Manager "Storage" tab: detail-view back button. */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_BACK = "resource-manager-storage-detail-back";
/** Resource Manager "Storage" tab: detail entry row. */
export const TID_RESOURCE_MANAGER_STORAGE_DETAIL_ENTRY = "resource-manager-storage-detail-entry";
/** Resource Manager "Storage" tab: cleanup confirmation dialog. */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_DIALOG =
  "resource-manager-storage-confirm-dialog";
/** Resource Manager "Storage" tab: cleanup confirmation button. */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_ACCEPT =
  "resource-manager-storage-confirm-accept";
/** Resource Manager "Storage" tab: cleanup cancel button. */
export const TID_RESOURCE_MANAGER_STORAGE_CONFIRM_CANCEL =
  "resource-manager-storage-confirm-cancel";
/** Master switch in the Memory Settings section. */
export const TID_SETTINGS_MEMORY_SWITCH = "settings-memory-switch";
/** Global instructions (~/.zcode/AGENTS.md) editor textarea. */
export const TID_SETTINGS_INSTRUCTIONS_EDITOR = "settings-instructions-editor";
/** Global instructions save button. */
export const TID_SETTINGS_INSTRUCTIONS_SAVE = "settings-instructions-save";
/** Global instructions "Discard changes" button. */
export const TID_SETTINGS_INSTRUCTIONS_DISCARD = "settings-instructions-discard";
/** Global instructions "Import from CLAUDE.md" button. */
export const TID_SETTINGS_INSTRUCTIONS_IMPORT = "settings-instructions-import";
/** Global instructions "Show in file manager" button. */
export const TID_SETTINGS_INSTRUCTIONS_REVEAL = "settings-instructions-reveal";
/** Retry button after global instructions fail to load. */
export const TID_SETTINGS_INSTRUCTIONS_RETRY = "settings-instructions-retry";
/** Global instructions target-host label. */
export const TID_SETTINGS_INSTRUCTIONS_HOST = "settings-instructions-host";
/** Global instructions edit/preview tab. */
export const TID_SETTINGS_INSTRUCTIONS_TAB_EDIT = "settings-instructions-tab-edit";
export const TID_SETTINGS_INSTRUCTIONS_TAB_PREVIEW = "settings-instructions-tab-preview";
/** Global instructions save-conflict dialog and its actions. */
export const TID_SETTINGS_INSTRUCTIONS_CONFLICT_DIALOG = "settings-instructions-conflict-dialog";
export const TID_SETTINGS_INSTRUCTIONS_CONFLICT_RELOAD = "settings-instructions-conflict-reload";
export const TID_SETTINGS_INSTRUCTIONS_CONFLICT_OVERWRITE =
  "settings-instructions-conflict-overwrite";
/** Web placeholder for "Desktop only." */
export const TID_SETTINGS_INSTRUCTIONS_DESKTOP_ONLY = "settings-instructions-desktop-only";
/** Refresh button in the Memory Settings section. */
export const TID_SETTINGS_MEMORY_REFRESH = "settings-memory-refresh";
/** Memory Workspace Scope menu trigger. */
export const TID_SETTINGS_MEMORY_SCOPE_TRIGGER = "settings-memory-scope-trigger";
/** Memory Workspace Scope icon. */
export const TID_SETTINGS_MEMORY_SCOPE_ICON = "settings-memory-scope-icon";
/** Number of files in the current Memory workspace. */
export const TID_SETTINGS_MEMORY_COUNT = "settings-memory-count";
/** Memory filename search input. */
export const TID_SETTINGS_MEMORY_SEARCH_INPUT = "settings-memory-search-input";
/** Clear Memory filename search button. */
export const TID_SETTINGS_MEMORY_SEARCH_CLEAR = "settings-memory-search-clear";
/** Back-to-project-list button from the Memory project file list. */
export const TID_SETTINGS_MEMORY_BACK_PROJECTS = "settings-memory-back-projects";
/** Back-to-project-files button from a Memory file body. */
export const TID_SETTINGS_MEMORY_BACK_MEMORIES = "settings-memory-back-memories";
/** Memory workspace row (dynamic suffix is the workspace ID). */
export const TID_SETTINGS_MEMORY_WORKSPACE = "settings-memory-workspace";

/** Memory file row (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE = "settings-memory-file";
/** Memory file-type icon (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE_ICON = "settings-memory-file-icon";
/** Memory filename (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE_NAME = "settings-memory-file-name";
/** Memory file update time (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE_UPDATED_AT = "settings-memory-file-updated-at";
/** Memory file editor action group (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS = "settings-memory-file-editor-actions";
/** Raw Markdown preview for Memory. */
export const TID_SETTINGS_MEMORY_PREVIEW = "settings-memory-preview";
/** Memory index budget chip showing "used/limit" index lines. */
export const TID_SETTINGS_MEMORY_INDEX_LINES = "settings-memory-index-lines";
/** Memory file frontmatter type badge (dynamic suffix is the filename). */
export const TID_SETTINGS_MEMORY_FILE_TYPE = "settings-memory-file-type";
/** Open-folder dropdown listing local workspaces with a Project Memory directory. */
export const TID_SETTINGS_MEMORY_OPEN_FOLDER = "settings-memory-open-folder";
/** AskUserQuestion auto-continue switch in General Settings. */
export const TID_SETTINGS_ASK_USER_QUESTION_AUTO_RESOLUTION_SWITCH =
  "settings-ask-user-question-auto-resolution-switch";
/** UI language dropdown trigger in the General Settings section. */
export const TID_SETTINGS_LOCALE_SELECT_TRIGGER = "settings-locale-select-trigger";
/** UI language dropdown item in the General Settings section (dynamic suffix is the locale preference). */
export const TID_SETTINGS_LOCALE_SELECT_ITEM = "settings-locale-select-item";
/** User/workspace MCP list row (dynamic suffix is the MCP runtime name). */
export const TID_MCP_SERVER_ROW = "mcp-server-row";
/** Plugin MCP list row (dynamic suffix is the MCP runtime name). */
export const TID_PLUGIN_MCP_SERVER_ROW = "plugin-mcp-server-row";
/** MCP OAuth authorization button (dynamic suffix is the MCP runtime name). */
export const TID_MCP_OPEN_AUTHORIZATION_BUTTON = "mcp-open-authorization-button";
/** Subagent list row (dynamic suffix is the subagent name). */
export const TID_SUBAGENT_ROW = "subagent-row";
/** Built-in subagent model selector (dynamic suffix is the subagent name). */
export const TID_SUBAGENT_BUILT_IN_MODEL_TRIGGER = "subagent-built-in-model-trigger";
/** Top-level usage-statistics tab in Settings (dynamic suffix is the usage tab ID). */
export const TID_SETTINGS_USAGE_TAB = "settings-usage-tab";
/** Remaining-usage submenu entry in the sidebar avatar menu. */
export const TID_SIDEBAR_USAGE_REMAINING_TRIGGER = "sidebar-usage-remaining-trigger";
/** Usage-statistics entry in the sidebar avatar menu. */
export const TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON = "sidebar-coding-plan-usage-button";
/** Interface zoom submenu trigger in the sidebar account menu. */
export const TID_SIDEBAR_INTERFACE_ZOOM_TRIGGER = "sidebar-interface-zoom-trigger";

// Model Provider Settings
/** Re-login action in the Coding Plan status card. */
export const TID_CODING_PLAN_RELOGIN_BUTTON = "coding-plan-relogin-button";
/** Subscribe action in the Coding Plan status card. */
export const TID_CODING_PLAN_SUBSCRIBE_BUTTON = "coding-plan-subscribe-button";
/** Manual Coding Plan quota reset action button. */
export const TID_CODING_PLAN_QUOTA_RESET_ACTION = "coding-plan-quota-reset-action";
/** Completed Coding Plan quota reset label. */
export const TID_CODING_PLAN_QUOTA_RESET_COMPLETED = "coding-plan-quota-reset-completed";
/** Coding Plan reset opportunity button. */
export const TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY = "coding-plan-quota-reset-opportunity";
/** Model test action in a model provider model row. */
export const TID_MODEL_PROVIDER_MODEL_TEST_BUTTON = "model-provider-model-test-button";
/** Get-API-key action for a model provider. */
export const TID_MODEL_PROVIDER_GET_API_KEY_BUTTON = "model-provider-get-api-key-button";
/** Add button at the top of Model Providers. */
export const TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON = "model-provider-add-provider-button";
/** Model Provider Template picker page. */
export const TID_MODEL_PROVIDER_TEMPLATE_PICKER = "model-provider-template-picker";
/** Model Provider Template choice (dynamic suffix is templateId; custom indicates fully custom). */
export const TID_MODEL_PROVIDER_TEMPLATE_ITEM = "model-provider-template-item";
/** Button to return from the Model Provider Template picker to the current Provider details. */
export const TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON = "model-provider-template-back-button";
/** Model Provider left-navigation item (dynamic suffix is the provider node key). */
export const TID_MODEL_PROVIDER_NAV_ITEM = "model-provider-nav-item";
/** Model Provider connection-mode dropdown trigger. */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_TRIGGER = "model-provider-connection-mode-trigger";
/** Quantity shortcut for existing Start Plans in Settings. */
export const TID_MODEL_PROVIDER_START_PLAN_COUNT_SHORTCUT =
  "model-provider-start-plan-count-shortcut";
export const TID_MODEL_PROVIDER_START_PLAN_SWITCH_PREFIX =
  "model-provider-start-plan-switch-prefix";
/** Model Provider connection-mode dropdown item (dynamic suffix is the connection-mode key). */
export const TID_MODEL_PROVIDER_CONNECTION_MODE_ITEM = "model-provider-connection-mode-item";
/** API Key input in Model Provider details. */
export const TID_MODEL_PROVIDER_API_KEY_INPUT = "model-provider-api-key-input";
/** Edit Model Provider name button. */
export const TID_MODEL_PROVIDER_NAME_EDIT_BUTTON = "model-provider-name-edit-button";
/** Model Provider name edit input. */
export const TID_MODEL_PROVIDER_NAME_INPUT = "model-provider-name-input";
/** Model Provider Base URL input. */
export const TID_MODEL_PROVIDER_BASE_URL_INPUT = "model-provider-base-url-input";
/** Model Provider API-format dropdown trigger. */
export const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "model-provider-api-format-trigger";
/** Model Provider API-format dropdown item (dynamic suffix is the API format). */
export const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "model-provider-api-format-item";
/** Model Provider model input (dynamic suffix is the model row index). */
export const TID_MODEL_PROVIDER_MODEL_INPUT = "model-provider-model-input";
/** Model Provider model delete button (dynamic suffix is the model row index). */
export const TID_MODEL_PROVIDER_MODEL_DELETE_BUTTON = "model-provider-model-delete-button";
/** Add Model Provider model button. */
export const TID_MODEL_PROVIDER_ADD_MODEL_BUTTON = "model-provider-add-model-button";

/** Visible toast notification item. */
export const TID_TOAST = "toast";

// Chat Toolbar
/** Model-selection button in the chat toolbar. */
export const TID_CHAT_MODEL_SELECT_TRIGGER = "chat-model-select-trigger";
/** Model Provider group in the chat toolbar (dynamic suffix is the provider group key). */
export const TID_CHAT_MODEL_SELECT_GROUP = "chat-model-select-group";
/** Model option in the chat toolbar (dynamic suffix is the model value). */
export const TID_CHAT_MODEL_SELECT_ITEM = "chat-model-select-item";
/** Reasoning-depth selection button in the chat toolbar. */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER = "chat-thought-level-select-trigger";
/** Reasoning-depth option in the chat toolbar (dynamic suffix is the reasoning-depth value). */
export const TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM = "chat-thought-level-select-item";
/** Mode-selection button in the chat toolbar (v4 switchCollaborationMode E2E anchor). */
export const TID_CHAT_MODE_SELECT_TRIGGER = "chat-mode-select-trigger";
/** Mode option in the chat toolbar (dynamic suffix is the mode value). */
export const TID_CHAT_MODE_SELECT_ITEM = "chat-mode-select-item";
/** Context-usage button in the chat toolbar. */
export const TID_CHAT_CONTEXT_USAGE_TRIGGER = "chat-context-usage-trigger";
/** Reasoning-block collapse trigger button. */
export const TID_CHAT_REASONING_TRIGGER = "chat-reasoning-trigger";
/** Reasoning-block collapsed-content container. */
export const TID_CHAT_REASONING_CONTENT = "chat-reasoning-content";

// Workspace
/** Main content-area header. */
export const TID_WORKSPACE_HEADER = "workspace-header";
/** Workspace title. */
export const TID_WORKSPACE_TITLE = "workspace-title";
/** Workspace path. */
export const TID_WORKSPACE_PATH = "workspace-path";
/** Workspace-header more-menu button. */
export const TID_WORKSPACE_MORE_BUTTON = "workspace-more-button";
/** Top-right question-mark help-menu trigger. */
export const TID_WORKSPACE_HELP_MENU_TRIGGER = "workspace-help-menu-trigger";
/** "Resource Manager" item in the question-mark help menu (Desktop only). */
export const TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER = "workspace-help-menu-resource-manager";
/** Sidebar open-workspace-file-tree button (dynamic suffix is workspacePath). */
export const TID_WORKSPACE_FILE_TREE_BUTTON = "workspace-file-tree-button";
/** Workspace file-tree panel. */
export const TID_WORKSPACE_FILE_TREE_PANEL = "workspace-file-tree-panel";
/** Workspace file-tree refresh button. */
export const TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON = "workspace-file-tree-refresh-button";
/** Workspace file-tree item (dynamic suffix is the absolute file path). */
export const TID_WORKSPACE_FILE_TREE_ROW = "workspace-file-tree-row";
// SSH error messages
/** SSH connection error message. */
export const TID_SSH_ERROR = "ssh-error";
/** SSH connection success message. */
export const TID_SSH_SUCCESS = "ssh-success";

// V4 session panes (protocol-v4 vertical slice; location protocol includes paneId so two panes for one session are distinguished by their suffix)
/** v4 session pane container (dynamic suffix is paneId). */
export const TID_V4_SESSION_PANE = "v4-session-pane";
/** v4 message timeline container. */
export const TID_V4_TIMELINE = "v4-timeline";
/** v4 timeline empty-state placeholder. */
export const TID_V4_TIMELINE_EMPTY = "v4-timeline-empty";
/** v4 projection row (dynamic suffix is rowId). */
export const TID_V4_ROW = "v4-row";
/** v4 workspace Hook pending-review banner container. */
export const TID_V4_WORKSPACE_HOOK_PENDING_BANNER = "v4-workspace-hook-pending-banner";
/** "Review" button in the v4 workspace Hook pending-review banner. */
export const TID_V4_WORKSPACE_HOOK_PENDING_REVIEW = "v4-workspace-hook-pending-review";
/** "Dismiss" button in the v4 workspace Hook pending-review banner. */
export const TID_V4_WORKSPACE_HOOK_PENDING_DISMISS = "v4-workspace-hook-pending-dismiss";
/** v4 Composer container. */
export const TID_V4_COMPOSER = "v4-composer";
/** v4 Composer text input. */
export const TID_V4_COMPOSER_INPUT = "v4-composer-input";
/** v4 Composer entry point for background tasks in the current session. */
export const TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER = "v4-composer-background-work-trigger";
/** Persistent Computer Use (CUA) entry button in v4 Composer. */
export const TID_V4_COMPOSER_CUA_ENTRY = "v4-composer-cua-entry";
export const TID_V4_COMPOSER_VOICE_ENTRY = "v4-composer-voice-entry";
/** v4 Composer send button. */
export const TID_V4_COMPOSER_SEND = "v4-composer-send";
/** v4 paused-queue send confirmation: clear queue and send. */
export const TID_V4_COMPOSER_CLEAR_QUEUE_SEND = "v4-composer-clear-queue-send";
/** v4 paused-queue send confirmation: keep queue and send. */
export const TID_V4_COMPOSER_KEEP_QUEUE_SEND = "v4-composer-keep-queue-send";
/** v4 paused-queue send confirmation dialog. */
export const TID_V4_PAUSED_QUEUE_SEND_DIALOG = "v4-paused-queue-send-dialog";
/** Attachment chip in V4 Composer (dynamic suffix is the attachment ID). */
export const TID_V4_ATTACHMENT = "v4-attachment";
/** Attachment upload progress in V4 Composer (dynamic suffix is the attachment ID). */
export const TID_V4_ATTACHMENT_UPLOAD_PROGRESS = "v4-attachment-upload-progress";
/** Attachment upload retry in V4 Composer (dynamic suffix is the attachment ID). */
export const TID_V4_ATTACHMENT_UPLOAD_RETRY = "v4-attachment-upload-retry";
/** v4 stop button. */
export const TID_V4_STOP = "v4-stop";
/** Fork button on a v4 assistant row (dynamic suffix is rowId). */
export const TID_V4_FORK = "v4-fork";
/** Retry button on a v4 assistant row (dynamic suffix is rowId). */
export const TID_V4_RETRY = "v4-retry";
/** Like button on a v4 assistant row (dynamic suffix is rowId). */
export const TID_V4_FEEDBACK_LIKE = "v4-feedback-like";
/** Dislike button on a v4 assistant row (dynamic suffix is rowId). */
export const TID_V4_FEEDBACK_DISLIKE = "v4-feedback-dislike";
/** Pin toggle button on a v4 assistant/user row (dynamic suffix is rowId). */
export const TID_V4_PIN = "v4-pin";
/** Pinned-message chips bar above the v4 timeline. */
export const TID_V4_PINNED_BAR = "v4-pinned-bar";
/** One chip in the pinned bar (dynamic suffix is rowId). */
export const TID_V4_PINNED_CHIP = "v4-pinned-chip";
/** Unpin button on a pinned bar chip (dynamic suffix is rowId). */
export const TID_V4_PINNED_CHIP_UNPIN = "v4-pinned-chip-unpin";
/** Details button for a v4 turn Hook (dynamic suffix is the product turnId). */
export const TID_V4_HOOK_DETAILS_TRIGGER = "v4-hook-details-trigger";
/** Details popover for a v4 turn Hook (dynamic suffix is the product turnId). */
export const TID_V4_HOOK_DETAILS_CONTENT = "v4-hook-details-content";
/** Edit button on a v4 user row (dynamic suffix is rowId). */
export const TID_V4_EDIT = "v4-edit";
/** Query edit input on a v4 user row (dynamic suffix is rowId). */
export const TID_V4_EDIT_INPUT = "v4-edit-input";
/** Submit button for editing a v4 user query (dynamic suffix is rowId). */
export const TID_V4_EDIT_SUBMIT = "v4-edit-submit";
/** Cancel button for editing a v4 user query (dynamic suffix is rowId). */
export const TID_V4_EDIT_CANCEL = "v4-edit-cancel";
/** Attachment removal button in a v4 user-query edit (dynamic suffix is rowId-index). */
export const TID_V4_EDIT_ATTACHMENT_REMOVE = "v4-edit-attachment-remove";
export const TID_V4_EDIT_REWIND_WORKSPACE = "v4-edit-rewind-workspace";
/** v4 edit file-conflict dialog. */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_DIALOG = "v4-edit-workspace-conflict-dialog";
/** Fallback to conversation-only trimming after a v4 edit file conflict. */
export const TID_V4_EDIT_WORKSPACE_CONFLICT_CONVERSATION_ONLY =
  "v4-edit-workspace-conflict-conversation-only";
/** v4 queue panel container. */
export const TID_V4_QUEUE = "v4-queue";
/** v4 paused-queue reason/resume banner. */
export const TID_V4_QUEUE_PAUSED_BANNER = "v4-queue-paused-banner";
/** v4 button to resume automatic consumption of a paused queue. */
export const TID_V4_QUEUE_RESUME = "v4-queue-resume";
/** Inline edit input for a v4 queue item (dynamic suffix is queueItemId). */
/** v4 queue item (dynamic suffix is queueItemId). */
export const TID_V4_QUEUE_ITEM = "v4-queue-item";
/** Delete button for a v4 queue item (dynamic suffix is queueItemId). */
export const TID_V4_QUEUE_ITEM_DELETE = "v4-queue-item-delete";
/** Edit button for a v4 queue item (dynamic suffix is queueItemId). */
export const TID_V4_QUEUE_ITEM_EDIT = "v4-queue-item-edit";
/** Send-now button for a v4 queue item (dynamic suffix is queueItemId). */
export const TID_V4_QUEUE_ITEM_SEND_NOW = "v4-queue-item-send-now";
/** Move-up button for a v4 queue item (dynamic suffix is queueItemId). */
export const TID_V4_QUEUE_ITEM_UP = "v4-queue-item-up";
/** v4 input control: queue autoDrain toggle button (setAutoDrain command). */
export const TID_V4_AUTODRAIN_TOGGLE = "v4-autodrain-toggle";
/** v4 input control: followup routing-mode toggle button (setFollowupMode command). */
export const TID_V4_FOLLOWUP_TOGGLE = "v4-followup-toggle";
/** v4 session title display (meta.title; shows a placeholder when empty). */
export const TID_V4_SESSION_TITLE = "v4-session-title";
/** v4 session rename input (renameSession command). */
export const TID_V4_RENAME_INPUT = "v4-rename-input";
/** v4 session rename submit button (renameSession command). */
export const TID_V4_RENAME_SUBMIT = "v4-rename-submit";
/** v4 goal-status banner (objective + status, projected from sendGoalCommand/resumeGoal results). */
export const TID_V4_GOAL_BANNER = "v4-goal-banner";
/** v4 session delete button (deleteSession command; returns to draft after deletion). */
export const TID_V4_DELETE_SESSION = "v4-delete-session";
/** v4 background-work panel (backgroundWorks projection). */
export const TID_V4_BACKGROUND_WORKS = "v4-background-works";
/** v4 background-work item (dynamic suffix is workId). */
export const TID_V4_BACKGROUND_WORK_ITEM = "v4-background-work-item";
/** v4 background-work cancel button (cancelBackgroundWork command; dynamic suffix is workId). */
export const TID_V4_BACKGROUND_WORK_CANCEL = "v4-background-work-cancel";
/** v4 model-config display (data-provider/data-model/data-thought, projected from switchModelConfig results). */
export const TID_V4_MODEL_CONFIG = "v4-model-config";
// v4-model-provider-input / v4-model-model-input / v4-model-thought-input /
// v4-model-apply (debug form) has been retired; model switching uses the Composer toolbar's
// TID_CHAT_MODEL_SELECT_* / TID_CHAT_THOUGHT_LEVEL_SELECT_*.
/** v4 reconnect button after subscription failure. */
export const TID_V4_RETRY_SUBSCRIBE = "v4-retry-subscribe";
/** v4 userInput interaction dialog container. */
export const TID_V4_USER_INPUT_DIALOG = "v4-user-input-dialog";
/** v4 userInput option button (dynamic suffix is optionId). */
export const TID_V4_USER_INPUT_OPTION = "v4-user-input-option";
/** v4 userInput free-text input. */
export const TID_V4_USER_INPUT_TEXT = "v4-user-input-text";
/** v4 timeline "Back to bottom" button (appears after leaving bottom-follow mode; virtual-scroll anchor). */
export const TID_V4_TIMELINE_BOTTOM = "v4-timeline-bottom";
/** v4 pane shell (Layout/Focus wrapper; dynamic suffix is paneId; data-focused marks the focused pane in split view). */
export const TID_V4_PANE_SHELL = "v4-pane-shell";
/** v4 split-pane-right button (pane header; phase one meant "Open split view," phase two generalizes it to splitting). */
export const TID_V4_SPLIT_OPEN = "v4-split-open";
/** v4 split-pane-down button (pane header, grid layout). */
export const TID_V4_SPLIT_DOWN = "v4-split-down";
/** v4 close-pane button (non-primary pane header; phase one meant "Close split view"). */
export const TID_V4_SPLIT_CLOSE = "v4-split-close";
/** v4 split-view drag divider (pointer drag adjusts width; data-split-id marks the split node). */
export const TID_V4_SPLIT_DIVIDER = "v4-split-divider";
/** Workspace badge in a v4 pane header (shows ownership for panes across workspaces). */
export const TID_V4_PANE_WORKSPACE_BADGE = "v4-pane-workspace-badge";
/** "Open in split view" in a sidebar session context menu (Desktop shell only, cleanup). */
export const TID_V4_TASK_OPEN_IN_SPLIT = "v4-task-open-in-split";
/** View model trajectory in a task context menu. */
export const TID_TASK_VIEW_MODEL_TRAJECTORY = "task-view-model-trajectory";
/** Refresh button in the model trajectory pane. */
export const TID_MODEL_TRAJECTORY_REFRESH = "model-trajectory-refresh";
/** v4 timeline "Load older" button (cursor pagination; appears when the first visible row is not the first row in the full order). */
export const TID_V4_TIMELINE_LOAD_OLDER = "v4-timeline-load-older";
/** v4 global conversation-turn navigation rail (appears on wide screens when 2+ turns can be navigated). */
export const TID_V4_TURN_NAVIGATOR = "v4-turn-navigator";
/** v4 conversation-turn navigation item (dynamic suffix is the render unit key). */
export const TID_V4_TURN_NAVIGATOR_ITEM = "v4-turn-navigator-item";
/** v4 conversation-turn navigation HoverCard preview (dynamic suffix is the render unit key). */
export const TID_V4_TURN_NAVIGATOR_TOOLTIP = "v4-turn-navigator-tooltip";
/** v4 subagent-row drill-down toggle (dynamic suffix is rowId; enabled only when childSessionId exists). */
export const TID_V4_SUBAGENT_TOGGLE = "v4-subagent-toggle";
/** v4 subagent drill-down mini timeline container (dynamic suffix is childSessionId). */
export const TID_V4_SUBAGENT_DRILLDOWN = "v4-subagent-drilldown";
/** v4 subagent drill-down "Open in split view" entry (dynamic suffix is childSessionId). */
/** @deprecated Subagent details moved to right-side tabs; keep the constant so external older tests still compile. */
export const TID_V4_SUBAGENT_OPEN_SPLIT = "v4-subagent-open-split";
export const TID_V4_SUBAGENT_OPEN_SIDE_PANE = "v4-subagent-open-side-pane";
/** v4 userInput row attachment list (dynamic suffix is rowId). */
export const TID_V4_ROW_ATTACHMENTS = "v4-row-attachments";

// Plugin store
/** Entry button to open the plugin store from Plugin Settings (the store is a WorkspaceShell main view, not a Settings section). */
export const TID_PLUGIN_STORE_BROWSE = "plugin-store-browse";

// Automations / scheduled tasks
export const TID_AUTOMATIONS_OPEN = "automations-open";
export const TID_AUTOMATIONS_LIST = "automations-list";
/** Shared status-filter pill row for scheduled/off-peak lists (all / in progress / completed / failed). */
export const TID_AUTOMATIONS_STATUS_FILTER = "automations-status-filter";
export const TID_AUTOMATION_CREATE_MENU = "automation-create-menu";
export const TID_AUTOMATION_CREATE_MANUALLY = "automation-create-manually";
export const TID_AUTOMATION_CARD = "automation-card";
// Off-peak tasks (separate surface)
export const TID_OFFPEAK_CREATE_BUTTON = "offpeak-create-button";
export const TID_OFFPEAK_CARD = "offpeak-card";
/** Schedule summary badge on an automation card. */
export const TID_AUTOMATION_CARD_SCHEDULE = "automation-card-schedule";
/** Run count on an automation card. */
export const TID_AUTOMATION_CARD_RUN_COUNT = "automation-card-run-count";
/** Off-peak card footnote: title of the bound session (created within the session). */
export const TID_OFFPEAK_CARD_SESSION = "offpeak-card-session";
export const TID_OFFPEAK_CARD_MENU = "offpeak-card-menu";
export const TID_OFFPEAK_EDIT_VIEW = "offpeak-edit-view";
export const TID_OFFPEAK_EDIT_SUBMIT = "offpeak-edit-submit";
export const TID_OFFPEAK_FORM_TITLE = "offpeak-form-title";
export const TID_OFFPEAK_FORM_INSTRUCTIONS = "offpeak-form-instructions";
export const TID_OFFPEAK_ACTION_PAUSE = "offpeak-action-pause";
export const TID_OFFPEAK_ACTION_CONTINUE = "offpeak-action-continue";
export const TID_OFFPEAK_ACTION_DELETE = "offpeak-action-delete";
export const TID_OFFPEAK_TAB = "offpeak-tab";
export const TID_AUTOMATION_CARD_MENU = "automation-card-menu";
export const TID_AUTOMATION_ACTION_TOGGLE = "automation-action-toggle";
export const TID_AUTOMATION_ACTION_DELETE = "automation-action-delete";
export const TID_AUTOMATION_FORM_TITLE = "automation-form-title";
export const TID_AUTOMATION_FORM_PROMPT = "automation-form-prompt";
export const TID_AUTOMATION_FORM_SUBMIT = "automation-form-submit";
export const TID_AUTOMATION_RUN_NOW = "automation-run-now";
export const TID_AUTOMATION_EDIT_BACK = "automation-edit-back";
// Schedule builder / custom recurrence / yearly month-day picker (stable E2E anchors)
export const TID_AUTOMATION_FREQUENCY_SELECT = "automation-frequency-select";
export const TID_AUTOMATION_FREQUENCY_OPTION = "automation-frequency-option";
export const TID_AUTOMATION_CUSTOM_UNIT_SELECT = "automation-custom-unit-select";
export const TID_AUTOMATION_CUSTOM_UNIT_OPTION = "automation-custom-unit-option";
export const TID_AUTOMATION_CUSTOM_INTERVAL_SELECT = "automation-custom-interval-select";
export const TID_AUTOMATION_CUSTOM_INTERVAL_INCREMENT = "automation-custom-interval-increment";
export const TID_AUTOMATION_CUSTOM_INTERVAL_DECREMENT = "automation-custom-interval-decrement";
export const TID_AUTOMATION_CUSTOM_INTERVAL_OPTION = "automation-custom-interval-option";
export const TID_AUTOMATION_CUSTOM_REPEAT_EDIT = "automation-custom-repeat-edit";
export const TID_AUTOMATION_CUSTOM_CONFIRM = "automation-custom-confirm";
export const TID_AUTOMATION_YEAR_MONTHDAY = "automation-year-monthday";
export const TID_AUTOMATION_YEAR_MONTH_OPTION = "automation-year-month-option";
export const TID_AUTOMATION_YEAR_DAY_OPTION = "automation-year-day-option";
export const TID_AUTOMATION_SCHEDULE_PREVIEW = "automation-schedule-preview";
export const TID_AUTOMATION_SCHEDULE_ADD = "automation-schedule-add";
export const TID_AUTOMATION_SCHEDULE_DELETE = "automation-schedule-delete";
export const TID_CRON_CREATE_CARD = "cron-create-card";
export const TID_CRON_CREATE_OPEN = "cron-create-open";
export const TID_OFFPEAK_CREATE_CARD = "offpeak-create-card";
export const TID_OFFPEAK_CREATE_OPEN = "offpeak-create-open";
export const TID_CONFIRM_DIALOG_CONFIRM = "confirm-dialog-confirm";

/** Generate a suffixed test ID for dynamic elements, such as file-tree-item-/home/user. */
export function testId(base: string, suffix: string): string {
  return `${base}-${suffix}`;
}

/** Manually claimable Start Plan banner above the avatar in the left sidebar. */
export const TID_MANUAL_CLAIM_PLAN_BANNER = "manual-claim-plan-banner";

/** Plugin UI sandbox card container and the webview inside it. */
export const TID_PLUGIN_UI_CARD = "plugin-ui-card";
export const TID_PLUGIN_UI_OPEN_SIDE_PANE = "plugin-ui-open-side-pane";
export const TID_PLUGIN_UI_WEBVIEW = "plugin-ui-webview";
export const TID_START_PLAN_RECOMMENDATION_DIALOG = "start-plan-recommendation-dialog";

/** Diagnostic-log consent toggle for user feedback. */
export const TID_FEEDBACK_LOGS_OPT_IN = "feedback-logs-opt-in";

/** Output styles settings section root. */
export const TID_SETTINGS_OUTPUT_STYLES_SECTION = "settings-output-styles-section";
/** One style row in the output styles list. */
export const TID_SETTINGS_OUTPUT_STYLES_ROW = "settings-output-styles-row";
export const TID_SETTINGS_OUTPUT_STYLES_DEFAULT_PROMPT = "settings-output-styles-default-prompt";
/** Output styles editor save button. */
export const TID_SETTINGS_OUTPUT_STYLES_SAVE = "settings-output-styles-save";

/** System prompt override settings section and per-key editor controls. */
export const TID_SETTINGS_SYSTEM_PROMPT_SECTION = "settings-system-prompt-section";
export const TID_SETTINGS_SYSTEM_PROMPT_ROW = "settings-system-prompt-row";
export const TID_SETTINGS_SYSTEM_PROMPT_EDIT = "settings-system-prompt-edit";
export const TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED = "settings-system-prompt-customized";
export const TID_SETTINGS_SYSTEM_PROMPT_DIFF = "settings-system-prompt-diff";
export const TID_SETTINGS_SYSTEM_PROMPT_EDITOR = "settings-system-prompt-editor";
export const TID_SETTINGS_SYSTEM_PROMPT_SAVE = "settings-system-prompt-save";
export const TID_SETTINGS_SYSTEM_PROMPT_RESTORE = "settings-system-prompt-restore";
export const TID_SETTINGS_SYSTEM_PROMPT_INFO = "settings-system-prompt-info";
export const TID_SETTINGS_SYSTEM_PROMPT_PATH = "settings-system-prompt-path";
export const TID_SETTINGS_SYSTEM_PROMPT_OPEN_FOLDER = "settings-system-prompt-open-folder";
export const TID_SETTINGS_SYSTEM_PROMPT_DIRTY = "settings-system-prompt-dirty";
export const TID_SETTINGS_SYSTEM_PROMPT_DIRTY_NOTE = "settings-system-prompt-dirty-note";
export const TID_SETTINGS_SYSTEM_PROMPT_WARNINGS = "settings-system-prompt-warnings";
export const TID_SETTINGS_SYSTEM_PROMPT_SAVE_REASON = "settings-system-prompt-save-reason";
export const TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED = "settings-system-prompt-disk-changed";
export const TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD = "settings-system-prompt-disk-reload";
export const TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE = "settings-system-prompt-disk-overwrite";
export const TID_SETTINGS_SYSTEM_PROMPT_DISK_SHOW = "settings-system-prompt-disk-show";
export const TID_SETTINGS_SYSTEM_PROMPT_DISK_VERSION = "settings-system-prompt-disk-version";
export const TID_SETTINGS_SYSTEM_PROMPT_DIFF_MODE = "settings-system-prompt-diff-mode";
export const TID_SETTINGS_SYSTEM_PROMPT_DIFF_TOO_LARGE = "settings-system-prompt-diff-too-large";
export const TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM = "settings-system-prompt-restore-confirm";
export const TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION =
  "settings-system-prompt-restore-confirm-action";
export const TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL = "settings-system-prompt-reset-all";
export const TID_SETTINGS_SYSTEM_PROMPT_RESET_ALL_CONFIRM =
  "settings-system-prompt-reset-all-confirm";
export const TID_SETTINGS_SYSTEM_PROMPT_ASSEMBLED = "settings-system-prompt-assembled";
export const TID_SETTINGS_SYSTEM_PROMPT_SIZE = "settings-system-prompt-size";
