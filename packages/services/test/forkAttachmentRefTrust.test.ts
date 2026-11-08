import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_REF_NOT_AUTHORIZED,
  attachmentRefAdmissionError,
} from "../src/zcode-agent/fork-attachment-ref-trust/contract.js";

// specs/fork-attachment-ref-trust-boundary.md
const SESSION = "sess_1";
const OWN_ARTIFACT = `zcode-artifact://${SESSION}/tool-result-0b1c`;

function attachment(ref: string, extra: Record<string, unknown> = {}) {
  return { ref, fileName: "a.txt", mime: "text/plain", bytes: 1, ...extra };
}

function sendText(refs: Array<ReturnType<typeof attachment>>, sessionId: string | null = SESSION) {
  return {
    type: "sendText",
    ...(sessionId === null ? {} : { sessionId }),
    payload: { text: "hi", attachments: refs },
  };
}

describe("attachmentRefAdmissionError", () => {
  it("refuses a mobile-origin local path", () => {
    expect(
      attachmentRefAdmissionError(
        sendText([attachment("/Users/someone/.ssh/id_ed25519")]),
        "web-remote-replayable",
      ),
    ).toEqual({
      code: ATTACHMENT_REF_NOT_AUTHORIZED,
      commandType: "sendText",
      reason: "local_path",
    });
    expect(
      attachmentRefAdmissionError(
        sendText([attachment("C:\\Users\\someone\\secret.txt")]),
        "web-remote-replayable",
      )?.reason,
    ).toBe("foreign_scheme");
    expect(
      attachmentRefAdmissionError(
        sendText([attachment("relative/file.txt")]),
        "web-remote-replayable",
      )?.reason,
    ).toBe("local_path");
  });

  it("refuses a mobile-origin artifact ref of another session", () => {
    for (const ref of [
      "zcode-artifact://sess_2/tool-result-0b1c",
      "zcode-artifact://share/version-1",
      // A URL parser would resolve the host after the userinfo; compare the raw encoded segment.
      `zcode-artifact://x@${SESSION}/tool-result-0b1c`,
    ]) {
      expect(
        attachmentRefAdmissionError(sendText([attachment(ref)]), "web-remote-replayable")?.reason,
      ).toBe("foreign_session");
    }
  });

  it("refuses malformed or non-artifact URIs from mobile", () => {
    for (const ref of [
      `zcode-artifact://${SESSION}/`,
      `zcode-artifact://${SESSION}/..`,
      `zcode-artifact://${SESSION}/a/b`,
      `zcode-artifact://${SESSION}/a%2F..%2Fb`,
      `zcode-artifact://${SESSION}/a?x=1`,
    ]) {
      expect(
        attachmentRefAdmissionError(sendText([attachment(ref)]), "web-remote-replayable")?.reason,
      ).toBe("malformed_artifact");
    }
    expect(
      attachmentRefAdmissionError(
        sendText([attachment("file:///etc/hosts")]),
        "web-remote-replayable",
      )?.reason,
    ).toBe("foreign_scheme");
  });

  it("refuses mobile artifact refs of a session id the artifact store would rewrite", () => {
    // "ses/1" and "ses_1" share one artifact directory, so "ses/1" may not name artifacts.
    for (const sessionId of ["ses/1", "ses 1", "s".repeat(121)]) {
      expect(
        attachmentRefAdmissionError(
          sendText(
            [attachment(`zcode-artifact://${encodeURIComponent(sessionId)}/tool-result-1`)],
            sessionId,
          ),
          "web-remote-replayable",
        )?.reason,
      ).toBe("unsafe_session");
    }
  });

  it("refuses a mobile previewRef that names a local path", () => {
    expect(
      attachmentRefAdmissionError(
        sendText([attachment(OWN_ARTIFACT, { previewRef: "/etc/hosts" })]),
        "web-remote-replayable",
      )?.reason,
    ).toBe("local_path");
  });

  it("gates editUserQuery and createSession.firstInput from mobile", () => {
    expect(
      attachmentRefAdmissionError(
        {
          type: "editUserQuery",
          sessionId: SESSION,
          payload: { newText: "x", attachments: [attachment("/etc/hosts")] },
        },
        "web-remote-replayable",
      )?.commandType,
    ).toBe("editUserQuery");
    expect(
      attachmentRefAdmissionError(
        {
          type: "createSession",
          payload: { firstInput: { text: "x", attachments: [attachment(OWN_ARTIFACT)] } },
        },
        "web-remote-replayable",
      )?.reason,
    ).toBe("no_session");
  });

  it("admits a mobile artifact ref of the command's own session", () => {
    expect(
      attachmentRefAdmissionError(
        sendText([attachment(OWN_ARTIFACT, { previewRef: `zcode-artifact://${SESSION}/p-1` })]),
        "web-remote-replayable",
      ),
    ).toBeUndefined();
    expect(
      attachmentRefAdmissionError(
        sendText([attachment("zcode-artifact://sess_7f3a-B.c/tool-result-1")], "sess_7f3a-B.c"),
        "web-remote-replayable",
      ),
    ).toBeUndefined();
    expect(attachmentRefAdmissionError(sendText([]), "web-remote-replayable")).toBeUndefined();
  });

  it("admits a desktop picker path and fork-parent artifact refs", () => {
    expect(
      attachmentRefAdmissionError(
        sendText([
          attachment("/Users/someone/Documents/picked.pdf"),
          attachment("zcode-artifact://sess_parent/tool-result-1"),
        ]),
        "desktop-continuous",
      ),
    ).toBeUndefined();
  });

  it("ignores commands that carry no attachments", () => {
    expect(
      attachmentRefAdmissionError(
        { type: "stop", sessionId: SESSION, payload: { attachments: [attachment("/etc/hosts")] } },
        "web-remote-replayable",
      ),
    ).toBeUndefined();
  });
});

describe("sendConversationCommandV4 attachment ref gate", () => {
  async function createService() {
    const getClient = vi.fn(async () => {
      throw new Error("runtime must not start for a refused command");
    });
    vi.resetModules();
    vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
      ZCodeAgentProcessManager: class {
        getClient = getClient;
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        markReady() {}
        isSharedRuntime() {
          return false;
        }
        getRuntimeWorkspaces(params: unknown) {
          return [params];
        }
        disposeAll() {}
      },
    }));
    const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
    return { service: createZCodeAgentService(), getClient };
  }

  const envelope = {
    commandId: "cmd-1",
    clientId: "client-1",
    sessionId: SESSION,
    type: "sendText" as const,
    payload: { text: "read this", attachments: [attachment("/etc/hosts")] },
    issuedAt: 1,
  };

  it("refuses a mobile local path before the agent runtime is reached", async () => {
    const { service, getClient } = await createService();
    try {
      await expect(
        service.sendConversationCommandV4({
          workspacePath: "/workspace/app",
          clientMode: "web-remote-replayable",
          envelope,
        }),
      ).rejects.toThrow(ATTACHMENT_REF_NOT_AUTHORIZED);
      expect(getClient).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("uses the trusted connection mode over a caller-supplied clientMode", async () => {
    const { service, getClient } = await createService();
    try {
      await expect(
        service.sendConversationCommandV4({
          workspacePath: "/workspace/app",
          clientMode: "desktop-continuous",
          envelope,
          __zcodeTrustedV4Connection: {
            connectionId: "conn-1",
            clientMode: "web-remote-replayable",
          },
        } as Parameters<typeof service.sendConversationCommandV4>[0]),
      ).rejects.toThrow(ATTACHMENT_REF_NOT_AUTHORIZED);
      expect(getClient).not.toHaveBeenCalled();
    } finally {
      service.disposeAll();
    }
  });

  it("admits a desktop local path past the gate", async () => {
    const { service } = await createService();
    try {
      // This harness has no model provider, so the command fails inside Host getClient, which runs
      // only after admission; that exact code proves the gate let the desktop path through.
      const error = await service
        .sendConversationCommandV4({ workspacePath: "/workspace/app", envelope })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );
      expect((error as { code?: unknown } | undefined)?.code).toBe(
        ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
      );
    } finally {
      service.disposeAll();
    }
  });
});
