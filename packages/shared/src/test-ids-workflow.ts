// Test IDs related to Dynamic Workflow.
// test-ids.ts reached oxlint's max-lines limit (400 lines), so the workflow family was moved out as a group;
// It is still exported from the @zcode/shared barrel, so consumer import paths do not change.

// GUI hub for saved workflows.
export const TID_AUTOMATIONS_PAGE_TAB = "automations-page-tab";
export const TID_WORKFLOWS_LIST = "workflows-list";
export const TID_WORKFLOWS_EMPTY = "workflows-empty";
export const TID_WORKFLOWS_REFRESH = "workflows-refresh";
export const TID_WORKFLOWS_CREATE_VIA_CHAT = "workflows-create-via-chat";
export const TID_WORKFLOW_PROJECT_GROUP = "workflow-project-group";
export const TID_WORKFLOW_GLOBAL_GROUP = "workflow-global-group";
export const TID_WORKFLOW_CARD = "workflow-card";
export const TID_WORKFLOW_CARD_RUN = "workflow-card-run";
export const TID_WORKFLOW_CARD_MENU = "workflow-card-menu";
export const TID_WORKFLOW_ACTION_DELETE = "workflow-action-delete";
export const TID_WORKFLOW_LAUNCH_DIALOG = "workflow-launch-dialog";
// 实参窗里唯一会滚动的那一段（「运行于」+ 实参字段）；头部与底部（说明、错误区、按钮）在它之外。
export const TID_WORKFLOW_LAUNCH_FIELDS = "workflow-launch-fields";
export const TID_WORKFLOW_LAUNCH_ARG = "workflow-launch-arg";
export const TID_WORKFLOW_LAUNCH_TARGET = "workflow-launch-target";
export const TID_WORKFLOW_LAUNCH_SUBMIT = "workflow-launch-submit";
// Direct start: inline error area in the arguments dialog. The session header receives a regular end-of-turn run card.
export const TID_WORKFLOW_LAUNCH_ERROR = "workflow-launch-error";
// End-of-turn run card; suffix = `${turnKey}-${toolCallId}`.
export const TID_CHAT_WORKFLOW_RUN_DIGEST = "workflow-run-digest";
export const TID_WORKFLOW_ACTION_MOVE = "workflow-action-move";
export const TID_WORKFLOW_MOVE_DIALOG = "workflow-move-dialog";
export const TID_WORKFLOW_MOVE_DIALOG_TARGET = "workflow-move-dialog-target";
export const TID_WORKFLOW_MOVE_DIALOG_SUBMIT = "workflow-move-dialog-submit";
export const TID_WORKFLOW_DETAIL = "workflow-detail";
export const TID_WORKFLOW_DETAIL_RUN = "workflow-detail-run";
export const TID_WORKFLOW_DETAIL_MENU = "workflow-detail-menu";
// 详情页标题旁的归属小标：项目名或「全局」。面包屑不带项目一级，归属只在这里说。
export const TID_WORKFLOW_DETAIL_PROJECT = "workflow-detail-project";
export const TID_WORKFLOW_DETAIL_TAB = "workflow-detail-tab";
export const TID_WORKFLOW_DETAIL_DESCRIPTION = "workflow-detail-description";
export const TID_WORKFLOW_DETAIL_WHEN_TO_USE = "workflow-detail-when-to-use";
export const TID_WORKFLOW_DETAIL_SCRIPT = "workflow-detail-script";
export const TID_WORKFLOW_META_SAVE = "workflow-meta-save";
export const TID_WORKFLOW_META_DISCARD = "workflow-meta-discard";
export const TID_WORKFLOW_RUN_ROW = "workflow-run-row";

// Four user-facing artifact surfaces.
//
// ⚠ Terminology: artifact here means output **published to users** by script `artifact.*` (file / Markdown /
// board), not the identically named engine-internal `RunSettlement.artifact` (the "top-level script return value").
//
// Only the four **entry-level** items belong here (section, card, tab root, chip): they are desktop E2E anchors. Duplicating them
// as literals in two places would eventually cause drift. Section-local version steppers, body kinds, and header actions remain literals in components, as do run detail page
// and other sections such as `workflow-run-questions`.
export const TID_WORKFLOW_ARTIFACTS_SECTION = "workflow-run-artifacts";
export const TID_WORKFLOW_ARTIFACTS_TOGGLE = "workflow-run-artifacts-toggle";
export const TID_WORKFLOW_ARTIFACT_CARD = "workflow-run-artifact-card";
/** Root node of the `workflow-artifact` side-panel tab. */
export const TID_WORKFLOW_ARTIFACT_PANE = "workflow-artifact-pane";
/** Chip in the hub (run history row / "Recent artifacts" on the details page). */
export const TID_WORKFLOW_ARTIFACT_CHIP = "workflow-run-artifact-chip";
/** Chip in the collapsed header of a terminal notification row in a session — **intentionally a different id** from the hub chip because their payload sources differ;
 *  E2E tests need to target "chips appeared on the notification row" and "chips appeared on the hub history row" separately. */
export const TID_CHAT_WORKFLOW_ARTIFACT_CHIP = "workflow-notification-artifact-chip";

// Dynamic workflow mode settings row and hub jump (docs/dynamic-workflow/launch.md, "The user's choice").
export const TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_TRIGGER = "settings-dynamic-workflow-mode-trigger";
/** The dynamic suffix is the mode (disabled / onDemand / alwaysOn). */
export const TID_SETTINGS_DYNAMIC_WORKFLOW_MODE_ITEM = "settings-dynamic-workflow-mode-item";
export const TID_WORKFLOWS_OPEN_SETTINGS = "workflows-open-settings";
