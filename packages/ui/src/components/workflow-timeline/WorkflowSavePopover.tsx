// The completion card's "save" popover (docs/dynamic-workflow/transcript-and-notifications.md
// "The popover").
//
// The two paths are ordered by **value**, not cost: first the full-width "let ZCode distill and save
// it", and only under a thin divider the three fields of "save as-is". A just-finished script is a
// one-off; extracting the values that change between runs into args and writing a clear description
// and usage timing is something only someone who read the script can do — so it comes first.
//
// The three fields serve both paths: what is filled in is handed to ZCode with the message and is
// also the copy that direct save writes.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SparkleIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope, ZCodeWorkflowsSaveResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkflowSaveFields, type WorkflowSaveFailure } from "./WorkflowSaveFields.js";
import {
  initialWorkflowSaveDraft,
  isValidSavedWorkflowNameText,
  savedWorkflowPathPreview,
  type WorkflowSaveDraft,
} from "./workflowRunSave.js";

/** Debounce window for the occupancy probe: querying the disk on every keystroke is meaningless; the moment the person pauses is the one that counts. */
const NAME_PROBE_DEBOUNCE_MS = 320;

export interface WorkflowSavePopoverHost {
  /** Used to pre-fill the name and description at the moment the popover opens. */
  runName?: string;
  /** Older agents lack `workflows/save`: only the ZCode path remains. */
  directSaveUnsupported: boolean;
  /** Remote projects get no global scope: `~` lives on the agent machine, which the hub never reads. */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: {
    name: string;
    scope: ZCodeSavedWorkflowScope;
    meta: { description: string };
    overwrite?: boolean;
  }) => Promise<ZCodeWorkflowsSaveResult>;
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  /**
   * Sends that user message (each host has its own send path: card in this session, pane in the
   * parent session). Absent means this path is unreachable — the popover keeps only the half below
   * the divider.
   */
  sendLead?: (draft: WorkflowSaveDraft) => Promise<void>;
  /** After a successful save: the parent uses this to flip to "run again" and announce once via aria-live. */
  onSaved: (saved: { name: string; scope: ZCodeSavedWorkflowScope }) => void;
}

export function WorkflowSavePopover({
  anchorRef,
  host,
  onOpenChange,
  open,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowSavePopoverHost;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        // On mobile the card is narrower than the popover: leave 8px from the screen edge and keep
        // the width within the viewport (it fits on a 320px screen).
        className="w-80 max-w-[calc(100vw-16px)] gap-2.5"
        collisionPadding={8}
        data-testid="workflow-save-popover"
        // Same as the "configure" popover: the portal lives outside, but React events still bubble
        // along the component tree; without stopping them, clicking blank space would be treated as
        // clicking the card itself.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        {/* Mount only while open: the draft's starting point is therefore this opening moment, and closing discards it (the Esc semantics). */}
        {open ? <WorkflowSaveForm host={host} onClose={() => onOpenChange(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function WorkflowSaveForm({
  host,
  onClose,
}: {
  host: WorkflowSavePopoverHost;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // The starting point is fixed at open time (same as the "configure" popover): if the run changes
  // while the popover is open, the form the user is editing must not be dragged back.
  const [draft, setDraft] = useState<WorkflowSaveDraft>(() =>
    initialWorkflowSaveDraft({
      ...(host.runName === undefined ? {} : { runName: host.runName }),
      ...(host.scopeLocked ? { scope: "project" as const } : {}),
    }),
  );
  const [probe, setProbe] = useState({ taken: false, shadowing: false });
  const [failure, setFailure] = useState<WorkflowSaveFailure | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Focus the name field on open (Tab order remains lead → name → scope → description → direct save).
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const name = draft.name.trim();
  const nameInvalid = name.length > 0 && !isValidSavedWorkflowNameText(name);
  const canDirectSave =
    !host.directSaveUnsupported && name.length > 0 && !nameInvalid && !host.saving;

  const { checkNameTaken, directSaveUnsupported, scopeLocked } = host;
  const { scope } = draft;
  // Occupancy probe: debounced 320ms, both scopes asked together — the target one decides "overwrite",
  // the other decides "shadowing". Invalidate the conclusion as soon as the name or scope changes, so
  // a stale answer never survives onto a new name.
  useEffect(() => {
    setProbe({ taken: false, shadowing: false });
    if (directSaveUnsupported || name.length === 0 || !isValidSavedWorkflowNameText(name)) return;
    let cancelled = false;
    const other: ZCodeSavedWorkflowScope = scope === "global" ? "project" : "global";
    const timer = window.setTimeout(() => {
      void Promise.all([
        checkNameTaken(name, scope),
        // Remote projects have only the project scope; asking about the other scope is pointless (the hub never reads the agent machine's `~`).
        scopeLocked ? Promise.resolve(false) : checkNameTaken(name, other),
      ]).then(([taken, shadowing]) => {
        if (!cancelled) setProbe({ taken, shadowing });
      });
    }, NAME_PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkNameTaken, directSaveUnsupported, name, scope, scopeLocked]);

  const update = (next: Partial<WorkflowSaveDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setFailure(undefined);
  };

  const handleLead = () => {
    if (host.sendLead === undefined || sending || host.saving) return;
    setSending(true);
    void host.sendLead({ ...draft, name }).then(
      () => onClose(),
      () => setSending(false),
    );
  };

  const handleDirectSave = () => {
    if (!canDirectSave) return;
    setFailure(undefined);
    void host
      .save({
        name,
        scope,
        // Fall back to the name when the description is empty: the hub card's line cannot be empty.
        meta: { description: draft.description.trim() || name },
        ...(probe.taken ? { overwrite: true } : {}),
      })
      .then(
        (result) => {
          if (result.ok) {
            host.onSaved({ name: result.name, scope: result.scope });
            onClose();
            return;
          }
          // Target already exists: not a failure, just an unconfirmed overwrite — surface the warning
          // and switch the button to "overwrite and save as-is".
          if (result.reason === "target_exists") {
            setProbe((current) => ({ ...current, taken: true }));
            return;
          }
          setFailure({
            reason: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
        },
        (error: unknown) => {
          setFailure({
            reason: "generic",
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      );
  };

  const pathPreview = useMemo(
    () => savedWorkflowPathPreview(scope, name.length > 0 ? name : "…"),
    [name, scope],
  );
  const submitLabel = host.saving
    ? format("chat.toolCall.workflow.saveRun.submit.saving")
    : probe.taken
      ? format("chat.toolCall.workflow.saveRun.submit.overwrite")
      : format("chat.toolCall.workflow.saveRun.submit");

  return (
    <div
      className="flex flex-col gap-2.5"
      // `⌘↩` / `Ctrl↩` from any field triggers the main path: the popover's claim is that one button.
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          handleLead();
        }
      }}
    >
      <PopoverTitle>{format("chat.toolCall.workflow.saveRun.title")}</PopoverTitle>
      {host.sendLead === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          <Button
            className="h-8 w-full"
            data-icon="inline-start"
            data-testid="workflow-save-lead"
            disabled={sending || host.saving}
            onClick={handleLead}
            type="button"
          >
            {sending ? <Spinner className="size-3.5" /> : <SparkleIcon className="size-3.5" />}
            {format(
              sending
                ? "chat.toolCall.workflow.saveRun.lead.sending"
                : "chat.toolCall.workflow.saveRun.lead",
            )}
          </Button>
          <p className="text-ui-sm leading-snug text-foreground-subtle">
            {format("chat.toolCall.workflow.saveRun.lead.hint")}
            {host.directSaveUnsupported
              ? ` ${format("chat.toolCall.workflow.saveRun.lead.unsupported")}`
              : ""}
          </p>
        </div>
      )}
      {host.directSaveUnsupported ? null : (
        <WorkflowSaveFields
          draft={draft}
          failure={failure}
          nameInvalid={nameInvalid}
          nameRef={nameRef}
          onDirectSave={handleDirectSave}
          pathPreview={pathPreview}
          saving={host.saving}
          scopeLocked={host.scopeLocked}
          shadowing={probe.shadowing}
          showDivider={host.sendLead !== undefined}
          submitDisabled={!canDirectSave}
          submitLabel={submitLabel}
          taken={probe.taken}
          update={update}
        />
      )}
    </div>
  );
}
