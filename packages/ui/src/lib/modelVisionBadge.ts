import type { ProviderConfigObject } from "@zcode/provider";

/** Product display exception: image input for the GLM-5.3 plan is server-bridged and must not be labeled as native vision. */
export function shouldShowModelVisionBadge(
  modelId: string,
  supportsImage: boolean | null | undefined,
  access?: ProviderConfigObject["access"],
): boolean {
  if (supportsImage !== true) return false;
  // The trial plan follows the same display exception as Coding Plan and hides only the GLM-5.3 badge.
  const hideGlm53Vision =
    access?.type === "zhipu-coding-plan-api-key" ||
    (access?.type === "zhipu-account" &&
      (access.mode === "individual-coding-plan" ||
        access.mode === "team-coding-plan" ||
        access.mode === "start-plan"));
  // This controls only the badge; it does not change capability facts, attachment validation, or exact model identity. Flash and other models are unaffected.
  return !(hideGlm53Vision && modelId.toLowerCase() === "glm-5.3");
}
