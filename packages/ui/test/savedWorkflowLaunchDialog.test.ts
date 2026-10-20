// @vitest-environment jsdom
// The launch dialog (docs/dynamic-workflow/launch.md "The launch dialog"): controls per type,
// default backfill, and collecting all errors at once.
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_LAUNCH_ARG,
  TID_WORKFLOW_LAUNCH_DIALOG,
  TID_WORKFLOW_LAUNCH_ERROR,
  TID_WORKFLOW_LAUNCH_FIELDS,
  TID_WORKFLOW_LAUNCH_SUBMIT,
  TID_WORKFLOW_LAUNCH_TARGET,
  type ZCodeSavedWorkflowArgsDeclaration,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import type { SavedWorkflowLaunchError } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "Pre-release check",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  args: {
    branch: { type: "string", required: true, description: "Target branch" },
    count: { type: "number", default: 3 },
    dry: { type: "boolean", default: true },
    extra: { type: "json" },
  },
};

const GLOBAL_ENTRY: ZCodeSavedWorkflowEntry = {
  name: "deep-research",
  description: "Deep research",
  scope: "global",
  path: "/home/.zcode/workflows/deep-research.dwf.ts",
};

// A declaration with many args (40): the 13th is required without a default,
// the 31st is json, the rest all have defaults.
// In a real window this form is far taller than the viewport; jsdom does not
// lay out, so only structure and focus are asserted here; height is covered by
// desktop e2e.
const MANY_ARGS_REQUIRED = "arg12";
const MANY_ARGS_JSON = "arg30";
const MANY_ARGS: ZCodeSavedWorkflowArgsDeclaration = {};
for (let index = 0; index < 40; index += 1) {
  const name = `arg${String(index).padStart(2, "0")}`;
  MANY_ARGS[name] =
    name === MANY_ARGS_REQUIRED
      ? { type: "string", required: true }
      : name === MANY_ARGS_JSON
        ? { type: "json" }
        : { type: "string", default: `v${index}` };
}
const MANY_ARGS_ENTRY: ZCodeSavedWorkflowEntry = {
  name: "arg-overflow",
  description: "Many arguments",
  scope: "global",
  path: "/home/.zcode/workflows/arg-overflow.dwf.ts",
  args: MANY_ARGS,
};

const ALPHA: AutomationWorkspaceOption = { workspacePath: "/repo/alpha", label: "Alpha" };
const BETA: AutomationWorkspaceOption = { workspacePath: "/repo/beta", label: "Beta" };
const TARGETS: readonly AutomationWorkspaceOption[] = [ALPHA, BETA];

// jsdom does not implement scrollIntoView; the launch dialog calls it on
// validation failure, so record who was scrolled into view.
const scrollIntoView = vi.fn();

// Radix Dialog needs ResizeObserver under jsdom; give it an empty implementation.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
});

function mount(
  entry: ZCodeSavedWorkflowEntry | null,
  extra: {
    targets?: readonly AutomationWorkspaceOption[];
    defaultTargetKey?: string | null;
    scope?: "project" | "global";
    projectLabel?: string;
    pending?: boolean;
    error?: SavedWorkflowLaunchError | null;
  } = {},
  onSubmit = vi.fn(),
  onOpenChange = vi.fn(),
) {
  const { scope, projectLabel, ...rest } = extra;
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SavedWorkflowLaunchDialog, {
        entry,
        scope: scope ?? entry?.scope ?? "project",
        projectLabel: projectLabel ?? "Beta",
        onOpenChange,
        onSubmit,
        ...rest,
      }),
    ),
  );
  return { onSubmit, onOpenChange };
}

describe("SavedWorkflowLaunchDialog", () => {
  it("does not render when entry is null", () => {
    mount(null);
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeNull();
  });

  it("renders controls per type with backfilled defaults; required marker; description visible", () => {
    mount(ENTRY);
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    // Header = name (mono) + scope badge + description; no more "Run {name}" title.
    expect(screen.getByText("release-check")).toBeTruthy();
    expect(screen.getByText(expectedCopy("workflows.hub.launch.scope.project"))).toBeTruthy();
    expect(screen.getByText("Pre-release check")).toBeTruthy();
    const branch = screen.getByTestId(
      testId(TID_WORKFLOW_LAUNCH_ARG, "branch"),
    ) as HTMLInputElement;
    expect(branch.type).toBe("text");
    expect(branch.value).toBe("");
    expect(screen.getByText(expectedCopy("workflows.hub.launch.required"))).toBeTruthy();
    expect(screen.getByText("Target branch")).toBeTruthy();
    const count = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "count")) as HTMLInputElement;
    expect(count.type).toBe("number");
    expect(count.value).toBe("3");
    const dry = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "dry"));
    expect(dry.getAttribute("role")).toBe("switch");
    expect(dry.getAttribute("aria-checked")).toBe("true");
    const extra = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra"));
    expect(extra.tagName).toBe("TEXTAREA");
  });

  it("collects required and json errors at once before submitting; after fixing them, submit receives type-parsed args", () => {
    const { onSubmit } = mount(ENTRY);
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra")), {
      target: { value: "{oops" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    // The badge "Required" and the error "Required" share copy: after the error
    // appears there should be two occurrences.
    expect(screen.getAllByText(expectedCopy("workflows.hub.launch.required"))).toHaveLength(2);
    expect(screen.getByText(expectedCopy("workflows.hub.launch.error.invalid_json"))).toBeTruthy();

    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "branch")), {
      target: { value: "main" },
    });
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "extra")), {
      target: { value: '{"a":1}' },
    });
    // Editing clears that field's error hint.
    expect(screen.getAllByText(expectedCopy("workflows.hub.launch.required"))).toHaveLength(1);
    expect(screen.queryByText(expectedCopy("workflows.hub.launch.error.invalid_json"))).toBeNull();
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "count")), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // count left empty → not sent (the server backfills from default); dry is
    // boolean and always has a value.
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ branch: "main", dry: true, extra: { a: 1 } });
  });

  it("the cancel button closes the dialog", () => {
    const { onOpenChange, onSubmit } = mount(ENTRY);
    fireEvent.click(screen.getByText(expectedCopy("workflows.hub.launch.cancel")));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('without targets, no "Run in" selector renders (project-scope path)', () => {
    mount(ENTRY);
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_TARGET)).toBeNull();
    expect(screen.queryByText(expectedCopy("workflows.hub.launch.target"))).toBeNull();
  });

  it("with targets, the selector renders and defaults to defaultTargetKey", () => {
    mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(BETA),
    });
    expect(screen.getByText(expectedCopy("workflows.hub.launch.target"))).toBeTruthy();
    const trigger = screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET);
    expect(trigger.textContent).toContain("Beta");
  });

  it("falls back to the first candidate when defaultTargetKey is not among the candidates", () => {
    mount(GLOBAL_ENTRY, { targets: TARGETS, defaultTargetKey: "no-such-key" });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET).textContent).toContain("Alpha");
  });

  it("hints and disables submit when the candidate list is empty", () => {
    mount(GLOBAL_ENTRY, { targets: [] });
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_TARGET)).toBeNull();
    expect(screen.getByText(expectedCopy("workflows.hub.launch.noLocalProject"))).toBeTruthy();
    expect((screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("a global workflow without args also opens the dialog; submit returns with the selected project", () => {
    const { onSubmit } = mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
    });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({});
    expect(onSubmit.mock.calls[0]?.[2]).toEqual(ALPHA);
  });

  it('the global-scope header renders the "Global" badge', () => {
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global" });
    expect(screen.getByText("deep-research")).toBeTruthy();
    expect(screen.getByText(expectedCopy("workflows.hub.launch.scope.global"))).toBeTruthy();
  });

  it("the note carries the project name: project scope uses the owning project", () => {
    mount(ENTRY, { projectLabel: "Beta" });
    expect(
      screen.getByText(expectedCopy("workflows.hub.launch.note", { project: "Beta" })),
    ).toBeTruthy();
  });

  it('the note carries the project name: global scope uses the selected "Run in" project', () => {
    mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      scope: "global",
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
    });
    expect(
      screen.getByText(expectedCopy("workflows.hub.launch.note", { project: "Alpha" })),
    ).toBeTruthy();
  });

  it("pending disables the submit button and clicking it no longer fires", () => {
    const { onSubmit } = mount(GLOBAL_ENTRY, {
      targets: TARGETS,
      scope: "global",
      defaultTargetKey: resolveAutomationWorkspaceSelectionKey(ALPHA),
      pending: true,
    });
    const submit = screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("the inline error region titles by reason and puts the server message in a mono block", () => {
    const error: SavedWorkflowLaunchError = {
      reason: "compile_failed",
      code: "fault.command.savedWorkflowStartRejected.compile_failed",
      message: "line 3: boom",
    };
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global", error });
    const region = screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR);
    expect(region.textContent).toContain(expectedCopy("workflows.hub.launch.error.compile_failed"));
    expect(region.textContent).toContain("line 3: boom");
  });

  it("maps the missing-capability error to the unsupported copy; no mono block without a message", () => {
    const error: SavedWorkflowLaunchError = {
      reason: "unsupported",
      code: "fault.command.capabilityUnsupported",
    };
    mount(GLOBAL_ENTRY, { targets: TARGETS, scope: "global", error });
    const region = screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR);
    expect(region.textContent).toContain(expectedCopy("workflows.hub.launch.error.unsupported"));
    expect(region.querySelector("pre")).toBeNull();
  });

  it('only "Run in" and the arg fields live in the scroll area; note, error region and buttons are pinned outside', () => {
    const error: SavedWorkflowLaunchError = {
      reason: "compile_failed",
      code: "fault.command.savedWorkflowStartRejected.compile_failed",
      message: "line 3: boom",
    };
    mount(MANY_ARGS_ENTRY, { targets: TARGETS, scope: "global", projectLabel: "Alpha", error });
    const dialog = screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG);
    const fields = screen.getByTestId(TID_WORKFLOW_LAUNCH_FIELDS);
    expect(dialog.contains(fields)).toBe(true);
    // Inside the scroll area: "Run in" and all 40 arg fields.
    expect(fields.contains(screen.getByTestId(TID_WORKFLOW_LAUNCH_TARGET))).toBe(true);
    for (const name of Object.keys(MANY_ARGS)) {
      expect(fields.contains(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, name)))).toBe(true);
    }
    // Outside the scroll area but inside the dialog: name, note, error region,
    // cancel and submit — however many args, they never get pushed out of view.
    const pinned = [
      screen.getByText("arg-overflow"),
      screen.getByText(expectedCopy("workflows.hub.launch.note", { project: "Alpha" })),
      screen.getByTestId(TID_WORKFLOW_LAUNCH_ERROR),
      screen.getByText(expectedCopy("workflows.hub.launch.cancel")),
      screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT),
    ];
    for (const element of pinned) {
      expect(dialog.contains(element)).toBe(true);
      expect(fields.contains(element)).toBe(false);
    }
  });

  it('renders no scroll area when there is neither "Run in" nor args', () => {
    mount({ ...GLOBAL_ENTRY, scope: "project" });
    expect(screen.getByTestId(TID_WORKFLOW_LAUNCH_DIALOG)).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOW_LAUNCH_FIELDS)).toBeNull();
  });

  it("on validation failure: the first invalid field is scrolled into view and focused", () => {
    const { onSubmit } = mount(MANY_ARGS_ENTRY, { targets: TARGETS, scope: "global" });
    const required = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, MANY_ARGS_REQUIRED));
    const json = screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, MANY_ARGS_JSON));
    fireEvent.change(json, { target: { value: "{oops" } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    // Both fields are invalid: take the first by declaration order (the
    // required one), not the later json one.
    expect(document.activeElement).toBe(required);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const revealed = scrollIntoView.mock.contexts[0] as HTMLElement;
    // What gets scrolled into view is the whole row (label + control + error),
    // not just the input.
    expect(revealed.contains(required)).toBe(true);
    expect(revealed.textContent).toContain(expectedCopy("workflows.hub.launch.error.required"));
    expect(revealed.contains(json)).toBe(false);

    // Fix the first one and submit again: the next invalid field takes over.
    fireEvent.change(required, { target: { value: "prod" } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(json);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("does not scroll when validation passes", () => {
    const { onSubmit } = mount(ENTRY);
    fireEvent.change(screen.getByTestId(testId(TID_WORKFLOW_LAUNCH_ARG, "branch")), {
      target: { value: "main" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_LAUNCH_SUBMIT));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
