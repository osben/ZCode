import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

type RemoteConnectionCompletionStatus = "success" | "error";

interface RemoteConnectionCompletionDialogState {
  open: boolean;
  step: RemoteWizardStep;
}

interface RemoteConnectionDirectoryFailureState {
  connectedSessionId: string | null;
  step: RemoteWizardStep;
}

export function isRemoteConnectionFlowActive(snapshot: RemoteConnectionDialogSnapshot): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
): RemoteConnectionCompletionDialogState {
  return {
    // If the remote connection dialog is dismissed, completion previously updated only its internal step and did not show it again,
    // leaving users on another page without the directory picker or failure reason. Show the dialog at the result step after connection completes.
    open: true,
    step: status === "success" ? "directory" : "connecting",
  };
}

export function getRemoteConnectionDirectoryFailureState(params: {
  connectedSessionId: string;
  sessionStillRegistered: boolean;
}): RemoteConnectionDirectoryFailureState {
  if (params.sessionStillRegistered) {
    return {
      connectedSessionId: params.connectedSessionId,
      step: "directory",
    };
  }

  // Workspace initialization failure releases the unconfirmed logical session.
  // If the directory step keeps the old sessionId, it receives empty services and remains in “loading” forever.
  return {
    connectedSessionId: null,
    step: "settings",
  };
}
