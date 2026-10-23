import { describe, expect, it } from "vitest";
import {
  resolveRemoteConnectionPhases,
  resolveRemoteConnectionPhaseSub,
} from "@/remote-connection/RemoteConnectionConnectingStep.js";
import {
  classifyRemoteConnectionError,
  formatRemoteConnectionError,
} from "@/lib/remoteConnectionPresentation.js";

describe("remote connection workspace step", () => {
  it("hides the workspace step when no project folder is known", () => {
    const phases = resolveRemoteConnectionPhases([
      { message: "[source-server:restart] restarting", level: "info" },
    ]);
    expect(phases.map((phase) => phase.key)).toEqual([
      "channel",
      "identify",
      "deploy",
      "handshake",
    ]);
  });

  it("adds Open project folder after handshake when a folder is known", () => {
    const phases = resolveRemoteConnectionPhases(
      [
        { message: "[source-server:restart] restarting", level: "info" },
        { message: "[source-server:workspace] Preparing /home/tester/app", level: "info" },
      ],
      { includeWorkspace: true },
    );
    expect(phases.map((phase) => [phase.key, phase.titleId])).toEqual([
      ["channel", "remote.phase.channel"],
      ["identify", "remote.phase.identify"],
      ["deploy", "remote.phase.deploy"],
      ["handshake", "remote.phase.handshake"],
      ["workspace", "remote.phase.workspace"],
    ]);
    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("complete");
    expect(phases.find((phase) => phase.key === "workspace")?.status).toBe("active");
  });

  it("counts workspace logs as handshake progress when no folder step is shown", () => {
    const phases = resolveRemoteConnectionPhases([
      { message: "[source-server:workspace] Preparing /home/tester/app", level: "info" },
    ]);
    expect(phases.find((phase) => phase.key === "handshake")?.status).toBe("active");
  });

  it("does not complete on publish-online while the folder step is still pending", () => {
    const logs = [{ message: "[source-server:publish-online] online", level: "info" as const }];
    const withFolder = resolveRemoteConnectionPhases(logs, { includeWorkspace: true });
    expect(withFolder.find((phase) => phase.key === "workspace")?.status).toBe("pending");
    expect(withFolder.find((phase) => phase.key === "handshake")?.status).toBe("active");

    const ready = resolveRemoteConnectionPhases(logs, {
      includeWorkspace: true,
      connectionReady: true,
    });
    expect(ready.every((phase) => phase.status === "complete")).toBe(true);
  });

  it("marks the folder step failed when the workspace preparation logs an error", () => {
    const phases = resolveRemoteConnectionPhases(
      [
        { message: "[source-server:restart] restarting", level: "info" },
        {
          message: "[source-server:workspace] Remote workspace directory did not respond",
          level: "error",
        },
      ],
      { includeWorkspace: true },
    );
    expect(phases.find((phase) => phase.key === "workspace")?.status).toBe("failed");
  });

  it("shows the folder being read in the workspace sub line", () => {
    expect(
      resolveRemoteConnectionPhaseSub(
        { key: "workspace", status: "active" },
        { workspacePath: "/home/tester/app" },
      ),
    ).toEqual({ id: "remote.phaseSub.workspaceReading", values: { path: "/home/tester/app" } });
  });
});

describe("remote connection hardening error presentation", () => {
  it("maps unsupported extra verification to a details action", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-authentication-unsupported",
    });
    expect(presentation.titleId).toBe("remote.error.authenticationUnsupported");
    expect(presentation.reasonId).toBe("remote.error.authenticationUnsupported.reason");
    expect(presentation.primaryAction).toBe("details");
    expect(presentation.category).toBe("remote-authentication-unsupported");
  });

  it("maps a Windows remote to a details action with the platform copy", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-platform-unsupported",
    });
    expect(presentation.titleId).toBe("remote.error.platformUnsupported");
    expect(presentation.primaryAction).toBe("details");
  });

  it("maps an unresponsive project folder to retry with its own copy", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-workspace-directory-unresponsive",
    });
    expect(presentation.titleId).toBe("remote.error.workspaceDirectoryUnresponsive");
    expect(presentation.reasonId).toBe("remote.error.workspaceDirectoryUnresponsive.reason");
    expect(presentation.primaryAction).toBe("retry");
    expect(
      formatRemoteConnectionError({
        fallback: "Remote workspace directory did not respond within 30 seconds",
        reasonCode: "remote-workspace-directory-unresponsive",
        retryable: true,
        formatMessage: ({ id }) => id,
      }),
    ).toBe("remote.error.workspaceDirectoryUnresponsive remote.error.retryableHint");
  });
});
