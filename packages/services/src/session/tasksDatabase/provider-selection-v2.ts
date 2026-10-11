import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/shared";

// Freeze the encoding decided before migration 0002 was released; do not call runtime parsers or identity tables that may change later.
// Preserve the escaping and delimiter precedence of the old decodeCustomModelValue / parseModelPickerValue behavior.
const providerNames: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

interface LegacySelectionRow {
  automation_id: string;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
}

function decodeLegacySelection(row: LegacySelectionRow): ModelSelection | undefined {
  const value = row.model?.trim();
  if (!value) return undefined;
  let provider = row.provider?.trim() ?? "";
  let model = value;
  let reasoningLevel = row.thought_level?.trim();
  if (value.startsWith("custom:")) {
    const body = value.slice(7);
    const separator = body.indexOf(":");
    if (separator < 0) return undefined;
    const parts = body.split(":");
    if (parts.length >= 3 && parts[0] === "builtin") {
      provider = `builtin:${parts[1]}`;
      model = decodeComponent(parts.slice(2).join(":"));
    } else {
      provider = decodeComponent(body.slice(0, separator));
      model = decodeComponent(body.slice(separator + 1));
    }
  } else if (value.includes("/")) {
    const separator = value.indexOf("/");
    provider = value.slice(0, separator);
    model = value.slice(separator + 1);
    const levelSeparator = model.indexOf("$");
    if (levelSeparator > 0 && levelSeparator < model.length - 1) {
      reasoningLevel = model.slice(levelSeparator + 1).trim();
      if (!reasoningLevel) return undefined;
      model = model.slice(0, levelSeparator);
    }
  } else if (["glm", "zcode"].includes(provider)) {
    // Legacy provider=glm/zcode values identify the execution backend, not the vendor.
    return undefined;
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) return undefined;
  const providerId = provider.startsWith("builtin:") ? providerNames[provider] : provider;
  if (!providerId) return undefined;
  return { providerId, modelId: model, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

/**
 * Frozen one-time conversion for migration 0002: runtime readers use only the new columns, while the three old columns remain untouched.
 * When legacy source data is available, reconstruct unpublished target values; leave identity as SQL NULL when it cannot be determined, and encode the default semantics as JSON null.
 * Must be called inside a database-level migration transaction; do not restore per-read imports.
 */
export function importLegacyAutomationSelections(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL",
    )
    .all() as unknown as LegacySelectionRow[];
  for (const row of rows) {
    const decoded = decodeLegacySelection(row);
    if (!decoded) {
      // An explicit legacy intent with unknown identity must not retain the unpublished intermediate "default" value, which could silently switch models.
      if (row.model?.trim())
        db.prepare("UPDATE automations SET model_selection=NULL WHERE automation_id=?").run(
          row.automation_id,
        );
      continue;
    }
    // The outer IMMEDIATE transaction keeps the legacy source and writes in the same snapshot; old columns and timestamps are not modified.
    db.prepare(
      `UPDATE automations SET model_selection = ?
       WHERE automation_id = ?
         AND model IS ? AND provider IS ? AND thought_level IS ?`,
    ).run(JSON.stringify(decoded), row.automation_id, row.model, row.provider, row.thought_level);
  }
  db.exec(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')`);
}
