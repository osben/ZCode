import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

export interface RemoteConnectionDialogSnapshot {
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

export function getRemoteConnectionCompletionDialogState(
  status: RemoteConnectionCompletionStatus,
  options?: { directToDirectory?: boolean },
): RemoteConnectionCompletionDialogState {
  return {
    // If the remote connection dialog is dismissed, completion previously updated only its internal step and did not show it again,
    // leaving users on another page without the directory picker or failure reason. Show the dialog at the result step after connection completes.
    open: true,
    // 连接成功后先停留在连接阶段，让用户明确点击“前往选择目录”进入下一步；
    // 唯一例外是第 1 步在线设备的「选择其他目录」直达流（原型 rail-foot：已有设备可从第 1 步直达第 5 步），
    // 建链秒成后直接进入选目录，不再停留等待一次多余的点击。
    step: status === "success" && options?.directToDirectory ? "directory" : "connecting",
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
