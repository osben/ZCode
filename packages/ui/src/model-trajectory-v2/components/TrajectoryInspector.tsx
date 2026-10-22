import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import type { LedgerRow } from "../domain/ledger.js";
import { tr, type TrajectoryIntl } from "./intl.js";
import {
  AssistantResult,
  RequestPayload,
  RowSummary,
  RowTiming,
  ToolPayload,
  ToolResult,
  ToolSchema,
  UserPayload,
} from "./TrajectoryInspectorSections.js";

export type InspectorTab = "summary" | "payload" | "result" | "schema" | "timing";

/** Tabs available for a row kind (specs/model-trajectory-v2.md, "Inspector"). */
export function inspectorTabs(row: LedgerRow): InspectorTab[] {
  switch (row.kind) {
    case "request":
      return ["summary", "payload", "timing"];
    case "tool":
      return ["summary", "payload", "result", "schema", "timing"];
    case "assistant":
      return ["summary", "result", "timing"];
    case "user":
    case "context":
      return ["summary", "payload"];
    default:
      return ["summary"];
  }
}

function tabContent(
  tab: InspectorTab,
  row: LedgerRow,
  model: TrajectoryV2Model,
  intl: TrajectoryIntl,
) {
  switch (tab) {
    case "summary":
      return <RowSummary row={row} model={model} intl={intl} />;
    case "timing":
      return <RowTiming row={row} model={model} intl={intl} />;
    case "payload":
      if (row.kind === "request") return <RequestPayload row={row} model={model} intl={intl} />;
      if (row.kind === "tool") return <ToolPayload row={row} />;
      if (row.kind === "user" || row.kind === "context") return <UserPayload row={row} />;
      return null;
    case "result":
      if (row.kind === "tool") return <ToolResult row={row} intl={intl} />;
      if (row.kind === "assistant") return <AssistantResult row={row} model={model} intl={intl} />;
      return null;
    case "schema":
      return row.kind === "tool" ? <ToolSchema row={row} model={model} intl={intl} /> : null;
  }
}

/** Block D: details of the selected ledger row. The chosen tab is kept while it exists for the next row. */
export function TrajectoryInspector({
  model,
  intl,
}: {
  model: TrajectoryV2Model;
  intl: TrajectoryIntl;
}) {
  const row = model.selectedRow;
  const [tab, setTab] = useState<InspectorTab>("summary");
  const tabs = row ? inspectorTabs(row) : [];
  const activeTab = tabs.includes(tab) ? tab : "summary";
  useEffect(() => {
    if (row && !inspectorTabs(row).includes(tab)) setTab("summary");
  }, [row, tab]);

  if (!row) {
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center text-ui-sm text-foreground-subtle"
        data-trajectory-v2-inspector="empty"
      >
        {tr(intl, "modelTrajectoryV2.inspector.empty")}
      </div>
    );
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setTab(value as InspectorTab)}
      className="flex h-full min-h-0 flex-col gap-0"
      data-trajectory-v2-inspector={row.kind}
      data-trajectory-v2-inspector-key={row.key}
    >
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        <TabsList variant="line">
          {tabs.map((item) => (
            <TabsTrigger key={item} value={item} data-trajectory-v2-tab={item}>
              {tr(intl, `modelTrajectoryV2.tab.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((item) => (
        <TabsContent
          key={item}
          value={item}
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-2"
        >
          {tabContent(item, row, model, intl)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
