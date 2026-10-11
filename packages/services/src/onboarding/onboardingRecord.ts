import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
  OnboardingDecision,
} from "@zcode/shared";
import { ServiceChannels, type AppSettings } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Fields copied from the record back to settings when login state changes (settings remains the sole runtime source of truth). */
export interface OnboardingSettingsSyncPatch {
  onboardingOccupation?: AppSettingsPatchOccupation;
  proactiveSuggestionsEnabled?: boolean;
  memoryEnabled?: boolean;
}

type AppSettingsPatchOccupation = NonNullable<AppSettings["onboardingOccupation"]>;

export interface IOnboardingRecordService {
  /**
   * Append an onboarding completion record. If the file is absent, create it and persist deviceMid (the file value is authoritative afterward);
   * the service fills userId from the current login state, so callers do not pass it.
   */
  appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void>;
  /** Trigger condition: true when the current user (logged in → userId; apikey/not logged in → null) has no matching record or the file is absent. */
  shouldOnboard(deviceMid: string): Promise<boolean>;
  /** Persist dismissed when the user closes first-run onboarding; no-op if answers already exist. */
  dismissOnboarding(deviceMid: string): Promise<void>;
  /**
   * Login claim: when the current userId has no entry and an anonymous (null) entry exists, transfer that entry to the userId
   * (rewrite rather than copy to avoid duplicate entries for one onboarding flow polluting upload metrics). The same person who answers once while logged out and then logs in
   * will not be treated as a new user and prompted again; prompting again after the anonymous record is gone is expected.
   * No-op when logged out (userId=null) or when an entry already exists.
   */
  claimAnonymousRecord(): Promise<void>;
  /** Current user's most recent answers (used to prefill onboarding when reopened); returns null when absent. */
  getLatestEntry(): Promise<OnboardingRecordEntry | null>;
  /**
   * Copy the current user's most recent answers in the record back to settings (restore that user's occupation/preferences after account switching,
   * which also switches recommendations). Fields recorded as null on skipped pages use conservative defaults (occupation other, preferences off),
   * matching the onboarding skip behavior; do not change settings if the user has no record.
   */
  syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null>;
  /**
   * Write preferences back to the record after the user changes them manually (keep the record at that user's latest preferences,
   * consistent with the settings UI, so account-switch sync does not revive a disabled option). Ignore when the current user has no entry.
   */
  updateRecordPreferences(
    patch: Partial<
      Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
    >,
  ): Promise<void>;
  /** Read the entire record file (used for later server upload); returns null if absent. */
  getRecords(): Promise<OnboardingRecordFile | null>;
  /** Delete the record file (debugging only). */
  clearRecords(): Promise<void>;
}

/** Factory input: inject userId resolution (oauthCredentialRepo in production wiring, a stub in tests). */
export interface CreateOnboardingRecordServiceOptions {
  loadUserId: () => Promise<string | null>;
  hasExistingLocalTask: () => Promise<boolean>;
}

export type OnboardingRecordServiceFactory = (
  options: CreateOnboardingRecordServiceOptions,
) => IOnboardingRecordService;

export const IOnboardingRecordService = createServiceDescriptor<IOnboardingRecordService>(
  ServiceChannels.OnboardingRecord,
);

export type {
  OnboardingDecision,
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
};
