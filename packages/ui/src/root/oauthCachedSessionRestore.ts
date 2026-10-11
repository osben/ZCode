import type { OAuthCachedSessionRestoreResult, UserInfo } from "@zcode/shared";
import type { AlertDialogRequest } from "@/store/alertDialogStore.js";

export async function applyCachedOAuthSessionRestoreResult(params: {
  result: OAuthCachedSessionRestoreResult;
  setUser: (user: UserInfo | null) => void;
  requestAlert: (request: AlertDialogRequest) => Promise<boolean>;
  onReauthenticationRequired: () => void;
  copy: AlertDialogRequest;
}): Promise<boolean> {
  if (params.result.status === "authenticated") {
    params.setUser(params.result.userInfo);
    return true;
  }

  if (params.result.status === "reauthentication-required") {
    // Authentication has already expired; do not wait for the user to confirm a dialog before clearing the UI login state.
    params.setUser(null);
    await params.requestAlert(params.copy);
    params.onReauthenticationRequired();
  }

  return false;
}
