import { useMemo, useState, type ReactNode } from "react";
import { reconstructTrajectoryRecords } from "@/ModelTrajectoryTimeline.js";
import { cn } from "@/components/lib/utils.js";
import type { ZCodeModelTrajectoryMessage } from "../contract.js";
import type { TrajectoryV2Model } from "../app/useTrajectoryV2Model.js";
import {
  formatBytes,
  formatClock,
  formatMs,
  formatRatio,
  formatTokens,
  prettyPayload,
} from "../domain/format.js";
import type { LedgerRow } from "../domain/ledger.js";
import { contextWindowFor } from "../domain/metrics.js";
import { describeParam, requestFacts } from "../domain/requestDiff.js";
import { tr, type TrajectoryIntl } from "./intl.js";

type RowOf<K extends LedgerRow["kind"]> = Extract<LedgerRow, { kind: K }>;
type Sections = { model: TrajectoryV2Model; intl: TrajectoryIntl };

function Fields({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-ui-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-foreground-subtle">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-foreground">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Pre({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-[60vh] overflow-auto rounded-md bg-surface/70 p-2 font-mono text-ui-xs whitespace-pre-wrap break-words",
        tone === "error" ? "text-destructive" : "text-foreground",
      )}
    >
      {text || "—"}
    </pre>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 pb-3">
      <h4 className="text-ui-xs font-medium text-foreground-subtle uppercase">{title}</h4>
      {children}
    </section>
  );
}

function messageText(message: ZCodeModelTrajectoryMessage): string {
  return message.parts
    .map((part) => {
      switch (part.kind) {
        case "text":
        case "reasoning":
          return part.text;
        case "tool-call":
          return `${part.toolName} ${prettyPayload(part.input)}`;
        case "tool-result":
          return prettyPayload(part.output);
        case "image":
          return "[image]";
        default:
          return prettyPayload(part.raw);
      }
    })
    .join("\n");
}

export function RowSummary({ row, model, intl }: { row: LedgerRow } & Sections) {
  const record =
    "recordIndex" in row && row.recordIndex !== undefined
      ? model.trajectory.records[row.recordIndex]
      : undefined;
  const items: [string, ReactNode][] = [
    [tr(intl, "modelTrajectoryV2.field.kind"), tr(intl, `modelTrajectoryV2.kind.${row.kind}`)],
  ];
  if (record) {
    const usage = record.response?.usage;
    const window = contextWindowFor(record, model.trajectory.contextWindows);
    items.push(
      [tr(intl, "modelTrajectoryV2.field.model"), record.model.modelId],
      [tr(intl, "modelTrajectoryV2.field.requestId"), record.requestId],
      [tr(intl, "modelTrajectoryV2.field.input"), formatTokens(usage?.inputTokens)],
      [tr(intl, "modelTrajectoryV2.field.output"), formatTokens(usage?.outputTokens)],
      [tr(intl, "modelTrajectoryV2.field.cacheRead"), formatTokens(usage?.cacheReadTokens)],
      [tr(intl, "modelTrajectoryV2.field.cacheWrite"), formatTokens(usage?.cacheWriteTokens)],
      [tr(intl, "modelTrajectoryV2.field.reasoning"), formatTokens(usage?.reasoningTokens)],
      [
        tr(intl, "modelTrajectoryV2.field.context"),
        window && usage?.inputTokens !== undefined
          ? `${formatRatio(usage.inputTokens / window)} (${formatTokens(usage.inputTokens + (usage.outputTokens ?? 0))} / ${formatTokens(window)})`
          : "—",
      ],
      [tr(intl, "modelTrajectoryV2.field.finish"), record.response?.finishReason],
    );
  }
  if (row.kind === "tool") {
    items.push(
      [tr(intl, "modelTrajectoryV2.field.tool"), row.toolName],
      [tr(intl, "modelTrajectoryV2.field.toolCallId"), row.toolCallId],
      [
        tr(intl, "modelTrajectoryV2.field.status"),
        row.timing?.status ?? (row.result ? (row.result.isError ? "error" : "completed") : "—"),
      ],
    );
  }
  if (row.kind === "marker")
    items.push([
      tr(intl, "modelTrajectoryV2.field.marker"),
      tr(intl, `modelTrajectoryV2.marker.${row.marker}`),
    ]);
  if (record?.error)
    items.push([
      tr(intl, "modelTrajectoryV2.field.error"),
      <span className="text-destructive">{record.error.message}</span>,
    ]);
  return <Fields items={items} />;
}

export function RowTiming({ row, model, intl }: { row: LedgerRow } & Sections) {
  if (row.kind === "tool") {
    const timing = row.timing;
    if (!timing)
      return (
        <p className="text-ui-sm text-foreground-subtle">
          {tr(
            intl,
            `modelTrajectoryV2.timing.${model.trajectory.toolTiming.source === "unavailable" ? "unavailable" : "missing"}`,
          )}
        </p>
      );
    const waitMs =
      timing.execStartedAt !== undefined ? timing.execStartedAt - timing.scheduledAt : undefined;
    return (
      <Fields
        items={[
          [tr(intl, "modelTrajectoryV2.timing.scheduled"), formatClock(timing.scheduledAt)],
          [tr(intl, "modelTrajectoryV2.timing.wait"), formatMs(waitMs)],
          [tr(intl, "modelTrajectoryV2.timing.execStart"), formatClock(timing.execStartedAt)],
          [tr(intl, "modelTrajectoryV2.timing.execEnd"), formatClock(timing.execEndedAt)],
          [tr(intl, "modelTrajectoryV2.timing.duration"), formatMs(timing.execDurationMs)],
          [tr(intl, "modelTrajectoryV2.timing.approval"), timing.approvalStatus],
        ]}
      />
    );
  }
  const record =
    "recordIndex" in row && row.recordIndex !== undefined
      ? model.trajectory.records[row.recordIndex]
      : undefined;
  if (!record) return null;
  const ttft = record.timing?.timeToFirstContentMs;
  return (
    <Fields
      items={[
        [tr(intl, "modelTrajectoryV2.timing.started"), formatClock(row.t0)],
        [tr(intl, "modelTrajectoryV2.timing.completed"), formatClock(row.t1)],
        [tr(intl, "modelTrajectoryV2.timing.duration"), formatMs(record.durationMs)],
        [tr(intl, "modelTrajectoryV2.timing.ttft"), formatMs(ttft)],
        [
          tr(intl, "modelTrajectoryV2.timing.decoding"),
          formatMs(
            ttft !== undefined && record.durationMs !== undefined
              ? record.durationMs - ttft
              : undefined,
          ),
        ],
        [
          tr(intl, "modelTrajectoryV2.timing.firstText"),
          formatMs(record.timing?.timeToFirstTextMs),
        ],
        [
          tr(intl, "modelTrajectoryV2.timing.stream"),
          record.timing ? String(record.timing.stream) : undefined,
        ],
      ]}
    />
  );
}

export function RequestPayload({ row, model, intl }: { row: RowOf<"request"> } & Sections) {
  const [showFull, setShowFull] = useState(false);
  const { trajectory } = model;
  const record = trajectory.records[row.recordIndex];
  const fullInput = useMemo(
    () =>
      showFull
        ? reconstructTrajectoryRecords(trajectory.records)[row.recordIndex]?.record.request.messages
        : undefined,
    [showFull, trajectory.records, row.recordIndex],
  );
  if (!record) return null;
  const facts = requestFacts(record, trajectory);
  const params = record.request.params;
  const system = record.request.systemPromptId
    ? trajectory.systemPrompts[record.request.systemPromptId]
    : undefined;
  const catalog = record.request.toolCatalogId
    ? trajectory.toolCatalogs[record.request.toolCatalogId]
    : undefined;
  const messages = fullInput ?? record.request.messages;
  return (
    <div data-trajectory-v2-payload="request">
      <Section title={tr(intl, "modelTrajectoryV2.payload.params")}>
        <Fields
          items={(
            [
              "maxOutputTokens",
              "thinking",
              "effort",
              "toolChoice",
              "temperature",
              "stream",
            ] as const
          ).map((key) => [key, describeParam(params, key)])}
        />
      </Section>
      <Section
        title={tr(intl, "modelTrajectoryV2.payload.system", {
          count: String(facts.systemBlockCount ?? 0),
          size: formatBytes(facts.systemBytes),
        })}
      >
        {system ? (
          system.blockIds.map((id, index) => {
            const block = trajectory.systemBlocks[id];
            return (
              <details key={id} className="text-ui-sm">
                <summary className="cursor-pointer text-foreground">{`#${index + 1} · ${formatBytes(block?.bytes)}${block?.omitted ? ` · ${tr(intl, "modelTrajectoryV2.payload.omitted")}` : ""}`}</summary>
                <Pre text={block?.text ?? ""} />
              </details>
            );
          })
        ) : (
          <p className="text-ui-sm text-foreground-subtle">
            {tr(intl, "modelTrajectoryV2.payload.systemFromInput")}
          </p>
        )}
      </Section>
      <Section
        title={tr(intl, "modelTrajectoryV2.payload.tools", {
          count: String(facts.toolCount ?? 0),
          size: formatBytes(facts.toolBytes),
        })}
      >
        <ul className="flex flex-col gap-0.5 font-mono text-ui-xs" data-trajectory-v2-catalog="">
          {(catalog?.toolDefIds ?? []).map((id) => {
            const def = trajectory.toolDefs[id];
            return (
              <li key={id} className="flex justify-between gap-2">
                <span className="truncate text-foreground">{def?.name ?? id}</span>
                <span className="shrink-0 text-foreground-subtle">{formatBytes(def?.bytes)}</span>
              </li>
            );
          })}
          {!catalog ? record.request.toolNames.map((name) => <li key={name}>{name}</li>) : null}
        </ul>
      </Section>
      <Section
        title={tr(intl, "modelTrajectoryV2.payload.breakpoints", {
          count: String(facts.breakpointCount),
        })}
      >
        <p className="font-mono text-ui-xs text-foreground">
          {record.request.cacheBreakpoints
            .map((point) => `${point.location}[${point.index}]${point.ttl ? ` ${point.ttl}` : ""}`)
            .join(", ") || "—"}
        </p>
        {!facts.breakpointsComplete ? (
          <p className="text-ui-xs text-foreground-subtle">
            {tr(intl, "modelTrajectoryV2.payload.breakpointsIncomplete")}
          </p>
        ) : null}
      </Section>
      <Section
        title={tr(
          intl,
          showFull ? "modelTrajectoryV2.payload.fullInput" : "modelTrajectoryV2.payload.newInput",
          { count: String(messages.length) },
        )}
      >
        {record.inputDeltaOf ? (
          <button
            type="button"
            className="self-start text-ui-xs text-foreground-subtle underline"
            onClick={() => setShowFull((value) => !value)}
          >
            {tr(
              intl,
              showFull ? "modelTrajectoryV2.payload.showNew" : "modelTrajectoryV2.payload.showFull",
            )}
          </button>
        ) : null}
        {messages.map((message, index) => (
          <details key={index} className="text-ui-sm">
            <summary className="cursor-pointer font-mono text-ui-xs text-foreground-subtle">{`${index + 1}. ${message.role}`}</summary>
            <Pre text={messageText(message)} />
          </details>
        ))}
      </Section>
    </div>
  );
}

export function ToolPayload({ row }: { row: RowOf<"tool"> }) {
  return <Pre text={prettyPayload(row.input)} />;
}

export function UserPayload({ row }: { row: RowOf<"user"> }) {
  return <Pre text={row.text} />;
}

export function ToolResult({ row, intl }: { row: RowOf<"tool">; intl: TrajectoryIntl }) {
  if (!row.result)
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {tr(intl, "modelTrajectoryV2.tool.pending")}
      </p>
    );
  return (
    <Pre text={prettyPayload(row.result.output)} tone={row.result.isError ? "error" : undefined} />
  );
}

export function ToolSchema({ row, model, intl }: { row: RowOf<"tool"> } & Sections) {
  const { trajectory } = model;
  const record = trajectory.records[row.recordIndex];
  const catalog = record?.request.toolCatalogId
    ? trajectory.toolCatalogs[record.request.toolCatalogId]
    : undefined;
  const def = catalog?.toolDefIds
    .map((id) => trajectory.toolDefs[id])
    .find((item) => item?.name === row.toolName);
  if (!def)
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {tr(intl, "modelTrajectoryV2.schema.missing")}
      </p>
    );
  return (
    <div data-trajectory-v2-schema={def.name}>
      <Section title={def.name}>
        <Pre text={def.description ?? ""} />
      </Section>
      <Section
        title={tr(intl, "modelTrajectoryV2.schema.parameters", { size: formatBytes(def.bytes) })}
      >
        {def.omitted ? (
          <p className="text-ui-sm text-foreground-subtle">
            {tr(intl, "modelTrajectoryV2.payload.omitted")}
          </p>
        ) : (
          <Pre text={prettyPayload(def.inputSchema)} />
        )}
      </Section>
    </div>
  );
}

export function AssistantResult({ row, model, intl }: { row: RowOf<"assistant"> } & Sections) {
  const calls = model.rows.filter(
    (item): item is RowOf<"tool"> => item.kind === "tool" && item.recordIndex === row.recordIndex,
  );
  return (
    <div>
      {row.error ? (
        <Section title={tr(intl, "modelTrajectoryV2.field.error")}>
          <Pre text={row.error} tone="error" />
        </Section>
      ) : null}
      <Section title={tr(intl, "modelTrajectoryV2.result.text")}>
        <Pre text={row.text ?? ""} />
      </Section>
      {row.reasoning ? (
        <Section title={tr(intl, "modelTrajectoryV2.result.reasoning")}>
          <Pre text={row.reasoning} />
        </Section>
      ) : null}
      {calls.length > 0 ? (
        <Section
          title={tr(intl, "modelTrajectoryV2.result.toolCalls", { count: String(calls.length) })}
        >
          <ul className="font-mono text-ui-xs">
            {calls.map((call) => (
              <li key={call.key}>
                <button
                  type="button"
                  className="text-left text-foreground underline"
                  onClick={() => model.select(call.key)}
                >
                  {call.toolName} {call.toolCallId}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
