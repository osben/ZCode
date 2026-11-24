import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import "@/styles.css";

// Providers with very different model counts, so browsing one changes the Models list height.
const groups: ComposerPlanGroup[] = [
  {
    key: "zai",
    label: "Z.ai",
    labelBadge: "Individual",
    items: Array.from({ length: 6 }, (_, index) => ({
      key: `glm-${index}`,
      value: `zai/glm-${index}`,
      name: `GLM-5.${index}`,
    })),
  },
  {
    key: "local",
    label: "LM Studio",
    labelBadge: "Local",
    items: [{ key: "qwen", value: "local/qwen", name: "Qwen 3 Coder" }],
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    labelBadge: "API",
    items: Array.from({ length: 12 }, (_, index) => ({
      key: `or-${index}`,
      value: `openrouter/model-${index}`,
      name: `openrouter/model-${index}`,
    })),
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    labelBadge: "API",
    items: [
      { key: "flash", value: "deepseek/flash", name: "DeepSeek Flash" },
      { key: "pro", value: "deepseek/pro", name: "DeepSeek Pro" },
    ],
  },
];

function Fixture() {
  const [model, setModel] = useState("zai/glm-2");
  const [effort, setEffort] = useState("medium");
  const [open, setOpen] = useState(true);
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <div className="flex h-screen items-end p-8">
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={model}
            triggerLabel={model}
            tooltipTitle={model}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={() => false}
            onValueChange={(value) => {
              setModel(value);
              (window as unknown as { writes: string[] }).writes.push(`model:${value}`);
            }}
            open={open}
            onOpenChange={setOpen}
            focusSelectorOnClose={null}
            composerOptions={{
              providerLabel: "Provider",
              modelsLabel: "Models",
              effortLabel: "Effort",
              selectModelLabel: "Select model",
              levels: [
                { value: "disabled", label: "Off" },
                { value: "medium", label: "Medium" },
                { value: "max", label: "Max" },
              ],
              value: effort,
              onValueChange: (value) => {
                setEffort(value);
                (window as unknown as { writes: string[] }).writes.push(`effort:${value}`);
              },
              providerMenu: {
                groups,
                selectedKey: groups.find((group) =>
                  group.items.some((item) => item.value === model),
                )?.key,
                pending: false,
                error: null,
                onSelectModel: (group, value) => {
                  setModel(value);
                  (window as unknown as { writes: string[] }).writes.push(
                    `pick:${group.key}:${value}`,
                  );
                },
              },
            }}
          />
        </div>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

(window as unknown as { writes: string[] }).writes = [];
document.documentElement.className = "dark theme-zai-dark";
createRoot(document.getElementById("root")!).render(<Fixture />);
