// The completion card's "save" popover (docs/dynamic-workflow/transcript-and-notifications.md "The popover").
//
// The two paths are ordered by **value**, not cost: first the full-width "let ZCode distill and save it for me", and
// only under a thin divider the three fields of "save as-is directly". A just-finished script is one-off; extracting
// the values that change between runs into args and writing a clear description and usage moment — only someone who
// has read the script can do that, so it comes first.
//
// The three fields serve both paths: whatever is filled in both travels to ZCode with the message and is the copy the
// direct save writes down.
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

/** Merge window for the taken-name probe: querying the disk on every keystroke is meaningless; the moment the person pauses is what counts. */
const NAME_PROBE_DEBOUNCE_MS = 320;

export interface WorkflowSavePopoverHost {
  /** Used to prefill the name and description at the moment the popover opens. */
  runName?: string;
  /** Old agents lack `workflows/save`: only the ZCode path remains. */
  directSaveUnsupported: boolean;
  /** Remote projects do not get the global scope: `~` lives on the agent machine and the hub never reads it. */
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
   * Sends that user message (each host has its own send path: the card in this session, the side pane in the parent
   * session).
   * Absent means this path is unreachable — the popover keeps only its half below the divider.
   */
  sendLead?: (draft: WorkflowSaveDraft) => Promise<void>;
  /** After a successful save: the parent uses this to flip to "run again" and fire one aria-live announcement. */
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
        // On mobile the card is narrower than the popover: keep 8px from the screen edge, and the width stays within
        // the viewport (fits a 320px screen too).
        className="w-80 max-w-[calc(100vw-16px)] gap-2.5"
        collisionPadding={8}
        data-testid="workflow-save-popover"
        // Same as the "configure" popover: the portal is outside yet React events still bubble along the component
        // tree; without stopping them, clicking blank space would be taken by the card as a click on the card itself.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        {/* Mounted only while open: the draft therefore starts at the moment of **this** opening, and closing discards
        it (the Esc semantics). */}
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
  // The starting point is fixed at open time (same as the "configure" popover): if the run changes while the popover
  // is open, the form the user is editing must not be yanked back.
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

  // Focus the name field on open (the Tab order is still lead → name → scope → description → direct save).
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const name = draft.name.trim();
  const nameInvalid = name.length > 0 && !isValidSavedWorkflowNameText(name);
  const canDirectSave =
    !host.directSaveUnsupported && name.length > 0 && !nameInvalid && !host.saving;

  const { checkNameTaken, directSaveUnsupported, scopeLocked } = host;
  const { scope } = draft;
  // Taken-name probe: debounced 320 ms, asking both scopes at once — the target one decides "overwrite", the other
  // decides "shadowing".
  // Any change to name or scope invalidates the conclusions first, so a stale answer never sticks to a new name.
  useEffect(() => {
    setProbe({ taken: false, shadowing: false });
    if (directSaveUnsupported || name.length === 0 || !isValidSavedWorkflowNameText(name)) return;
    let cancelled = false;
    const other: ZCodeSavedWorkflowScope = scope === "global" ? "project" : "global";
    const timer = window.setTimeout(() => {
      void Promise.all([
        checkNameTaken(name, scope),
        // A remote project only has the project scope; asking about the other scope is pointless (the hub never reads
        // the agent machine's `~`).
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
        // Fall back to the name when the description is empty: that line on the hub's card must not be blank.
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
          // The target already exists: not a failure, just an unconfirmed overwrite — surface the warning and switch
          // the button to "overwrite and save directly".
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
      // `⌘↩` / `Ctrl↩` from any field triggers the main path: the popover's whole claim is that one button.
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
