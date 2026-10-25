// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import type { ProjectDevice } from "@/project-sidebar/contract.js";
import enUS from "@/i18n/locales/en-US.js";
import { expectedCopy } from "./helpers/uiCopy.js";

Element.prototype.scrollIntoView = vi.fn();
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        Object.entries(values ?? {}).reduce(
          (text, [key, value]) => text.replace(`{${key}}`, value),
          (enUS as Record<string, string>)[id] ?? id,
        ),
    },
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => null }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => vi.fn(async () => true) }));
vi.mock("@/project-sidebar/useProjectDirectoryServices.js", () => ({
  useProjectDirectoryServices: () => ({ services: {} }),
}));
vi.mock("@/RemoteConnectionDialogContent.js", () => ({
  useRemoteBoundaryAcknowledgement: () => async () => true,
}));
afterEach(cleanup);

const devices: ProjectDevice[] = [
  { id: "remote:offline", label: "Offline box", status: "offline" },
  { id: "remote:online", label: "Online box", status: "online" },
  { id: "remote:connecting", label: "Connecting box", status: "connecting" },
  { id: "remote:pending", label: "Pending box", status: "pending" },
  { id: "remote:failed", label: "Failed box", status: "failed" },
];

function editor(defaultDeviceId = "remote:offline") {
  const onBrowseExisting = vi.fn(async () => true);
  render(
    createElement(ProjectEditor, {
      project: null,
      projects: [],
      devices,
      defaultDeviceId,
      service: { readTree: vi.fn(async () => ({ projects: [], tasks: [] })) } as never,
      remoteService: {} as never,
      onBrowseExisting,
      onAddDevice: vi.fn(),
      onClose: vi.fn(),
      onSaved: vi.fn(async () => {}),
    }),
  );
  return { onBrowseExisting };
}

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

it("orders fields as name, device, then folders", () => {
  editor();
  const device = screen.getByTestId("virtual-project-device");
  const name = screen.getByTestId("virtual-project-name");
  const browse = screen.getByTestId("virtual-project-browse");
  expect(before(name, device)).toBe(true);
  expect(before(device, browse)).toBe(true);
});

it("shows a status dot for every remote device and text only when it is not online", async () => {
  editor();
  const trigger = screen.getByTestId("virtual-project-device");
  const triggerStatus = within(trigger).getByTestId("virtual-project-device-status");
  expect(triggerStatus.dataset.status).toBe("offline");
  expect(triggerStatus.textContent).toBe(expectedCopy("project.deviceStatus.offline"));
  fireEvent.click(trigger);
  const option = async (label: string) =>
    within(await screen.findByRole("option", { name: new RegExp(label) })).queryByTestId(
      "virtual-project-device-status",
    );
  expect(await option(expectedCopy("project.thisComputer"))).toBeNull();
  const online = (await option("Online box"))!;
  expect(online.querySelector(".bg-success")).toBeTruthy();
  // Online keeps only the dot; the text is exposed to screen readers only.
  expect(online.querySelector(".sr-only")?.textContent).toBe(
    expectedCopy("project.deviceStatus.online"),
  );
  const connecting = (await option("Connecting box"))!;
  expect(connecting.querySelector(".animate-spin")).toBeTruthy();
  expect(connecting.textContent).toBe(expectedCopy("project.deviceStatus.connecting"));
  expect((await option("Pending box"))!.querySelector(".bg-warning")).toBeTruthy();
  expect((await option("Pending box"))!.textContent).toBe(
    expectedCopy("project.deviceStatus.pending"),
  );
  expect((await option("Failed box"))!.querySelector(".bg-destructive")).toBeTruthy();
  expect((await option("Failed box"))!.textContent).toBe(
    expectedCopy("project.deviceStatus.failed"),
  );
  expect(
    await screen.findByRole("option", { name: expectedCopy("project.addRemoteDevice") }),
  ).toBeTruthy();
});

it("remote existing-project entry returns focus after browsing", async () => {
  const { onBrowseExisting } = editor();
  const entry = screen.getByTestId("virtual-project-existing");
  expect(entry.textContent).toBe(expectedCopy("project.existingOnDeviceAction"));
  expect(entry.closest("p")?.textContent).toContain(expectedCopy("project.existingOnDeviceHint"));
  expect(before(screen.getByTestId("virtual-project-device"), entry)).toBe(true);
  expect(before(screen.getByTestId("virtual-project-name"), entry)).toBe(true);
  expect(before(entry, screen.getByTestId("virtual-project-browse"))).toBe(true);

  fireEvent.click(entry);
  await waitFor(() => expect(onBrowseExisting).toHaveBeenCalledOnce());
  const back = await screen.findByTestId("remote-project-back");
  expect(back.getAttribute("aria-label")).toBe(expectedCopy("project.backToCreate"));
  expect(screen.queryByText(expectedCopy("project.backToCreate"))).toBeNull();
  fireEvent.click(back);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByTestId("virtual-project-existing")),
  );
});

it("hides the existing-project entry for this computer", () => {
  editor("local");
  expect(screen.queryByTestId("virtual-project-existing")).toBeNull();
});

it("explains connection for a device that is not online", () => {
  editor();
  const browse = screen.getByTestId("virtual-project-browse");
  expect(browse.getAttribute("aria-label")).toBe(expectedCopy("project.connectAndBrowse"));
  expect(browse.textContent).toContain(
    expectedCopy("project.connectAndBrowseHint", {
      status: expectedCopy("project.deviceStatus.offline"),
    }),
  );
});

it("uses the choose-folder empty state for an online device", () => {
  editor("remote:online");
  const browse = screen.getByTestId("virtual-project-browse");
  expect(browse.getAttribute("aria-label")).toBe(expectedCopy("project.browse"));
  expect(browse.textContent).toContain(expectedCopy("project.browseHint"));
});
