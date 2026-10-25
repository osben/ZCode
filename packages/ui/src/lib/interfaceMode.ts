export type InterfaceMode = "office" | "coding";

export const INTERFACE_MODE_STORAGE_KEY = "zcode-interface-mode";

export function normalizeInterfaceMode(value: unknown): InterfaceMode {
  // localStorage (zcode-interface-mode) may still contain the pre-rename values "general"/"concise".
  // Map them to the new "office" value; otherwise existing users would be normalized to coding on upgrade and silently lose their choice.
  return value === "office" || value === "general" || value === "concise" ? "office" : "coding";
}
