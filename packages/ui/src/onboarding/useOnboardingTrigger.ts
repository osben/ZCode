import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { logger } from "@/logger.js";

/**
 * Determine whether to show onboarding: the current user needs onboarding when there is no local record.
 * Settings backfill (restoring preferences after switching accounts) happens only after userId changes at runtime.
 * Manual changes are written back to the record by each entry point (updateRecordPreferences), so the record always matches the user's latest preferences.
 *
 * Returns [needsOnboarding, markOnboarded]: null means the async check is pending; after onboarding saves successfully, markOnboarded sets the result to false (the record is persisted, so onboarding will not trigger again in this session).
 */
export function useOnboardingTrigger(options: {
  onboardingRecord: ReturnType<typeof useOnboardingRecordService>;
  userId: string | null;
  hasStoredOccupation: boolean;
  loadDeviceMid: () => string;
  update: (patch: Partial<AppSettings>) => Promise<void>;
}): [boolean | null, () => void] {
  const { onboardingRecord, userId, hasStoredOccupation, loadDeviceMid, update } = options;
  // null means the async check is pending (whether to show onboarding is determined from the local usage record).
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  // Remember the userId from the previous check; backfill occurs only after the identity actually changes (see the condition below).
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const fallback = () => !hasStoredOccupation;
    // If the service is unavailable (an old test double or an unregistered host), fall back to the old settings check without changing its behavior.
    if (!onboardingRecord) {
      setNeedsOnboarding(fallback());
      return;
    }
    // shouldOnboard uses RPC and can hang if the host does not provide the onboarding-record channel.
    // Previously, rendering null while checking left the entire main UI on a permanent black screen.
    // Fall back to the settings check after a timeout so the main UI waits no longer than 3 seconds.
    const timeout = setTimeout(() => {
      if (!cancelled) {
        logger.warn("[occupation-onboarding] shouldOnboard 超时，退回 settings 判定");
        setNeedsOnboarding(fallback());
      }
    }, 3000);
    // Claim the record on login first: transfer onboarding answers made while logged out (a null entry) to the current user, so the same person is not prompted again.
    // Wait for the claim to finish before checking; otherwise shouldOnboard may read the pre-claim file and incorrectly prompt again.
    onboardingRecord
      .claimAnonymousRecord()
      .catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 认领匿名引导记录失败", { error: String(cause) });
      })
      .then(() => onboardingRecord.shouldOnboard(loadDeviceMid()))
      .then(
        (result) => {
          if (!cancelled) setNeedsOnboarding(result);
          // Restore a user's preferences when switching accounts: settings are not user-specific, so after A answers, onboarding for B overwrites settings with B's answers. Switching back to A restores the most recent answers from A's record. Sync failures are only logged.
          // Backfill only when the previous identity was another non-empty identity (A→B directly or B→logged out). Do not backfill null→id: OAuth restore at startup and login during a running session share this sequence and cannot be distinguished, so favor skipping backfill. Manual changes are already written to the record by each entry point (the record contains the latest preferences); missing backfill affects only edge cases such as logging into an old account after using an API key.
          const previousUserId = lastSyncedUserIdRef.current;
          lastSyncedUserIdRef.current = userId;
          if (!cancelled && !result && previousUserId != null && previousUserId !== userId) {
            void onboardingRecord
              .syncSettingsFromRecord()
              .then((patch) => {
                if (cancelled || !patch) return;
                return update(patch);
              })
              .catch((cause: unknown) => {
                logger.warn("[occupation-onboarding] 按记录同步偏好失败", {
                  error: String(cause),
                });
              });
          }
        },
        (cause) => {
          logger.warn("[occupation-onboarding] shouldOnboard 检查失败", { error: String(cause) });
          if (!cancelled) setNeedsOnboarding(fallback());
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // Do not depend on hasStoredOccupation (settings?.onboardingOccupation): a successful save updates that field, while a failed record write would reopen onboarding immediately. As agreed, a missing record triggers onboarding again on the next launch.
  }, [onboardingRecord, userId, loadDeviceMid]);
  return [needsOnboarding, () => setNeedsOnboarding(false)];
}
