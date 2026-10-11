type OAuthCallback = (url: string) => void | Promise<void>;

export function createOAuthCallbackHandler(callback: OAuthCallback, notifyHandled: () => void) {
  return async (_event: unknown, url: string): Promise<void> => {
    try {
      await callback(url);
    } catch {
      // Preload only bridges the OAuth callback and main-process handshake. Do not rethrow renderer
      // callback errors as unhandled rejections.
      // The renderer displays product errors; here, always send a handled acknowledgement to main whether
      // the callback succeeds or fails.
    } finally {
      notifyHandled();
    }
  };
}
