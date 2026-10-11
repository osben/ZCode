import { useServices } from "./useServices.js";

/**
 * Onboarding completion record service (persisted locally and uploaded to the server later).
 * Returns null when an older test double or unsupported host has not registered this service; callers must handle the absence.
 * Pure rendering tests without a ServiceProvider (where this service is unrelated to the behavior under test) also return null instead of throwing—
 * useContext is called inside try and runs on every render, keeping the hook call order stable.
 */
export function useOnboardingRecordService() {
  try {
    const services = useServices();
    return services.onboardingRecordService ?? null;
  } catch {
    return null;
  }
}
