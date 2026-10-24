# Plan Mode Status (Current Facts)

The old `PlanModeToolPanel` and its "Plan / Raw data" tabs are removed. Plan/goal/todo state is shown in
the V4 `ConversationStatusPanel`; collaboration-mode switching goes through `switchCollaborationMode`
and the composer toolbar.

The status panel renders a projection only; it holds no independent plan facts and has no raw-data tab.
