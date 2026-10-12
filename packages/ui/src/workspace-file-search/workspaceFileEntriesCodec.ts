// The implementation moved up to @zcode/shared/workspaceFileEntriesCodec (the services/Host
// side needs it too; layering rules no longer allow it in the ui package). This file remains
// as a forwarding exit: the historical import paths used by workspaceFileSearchFilterBackend
// and the worker keep working, and the git diff avoids showing "deleted code file" entries
// that would trigger a full fallback in pre-push affected.
export * from "@zcode/shared/workspaceFileEntriesCodec";
