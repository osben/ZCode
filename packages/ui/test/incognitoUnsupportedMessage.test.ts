import { describe, expect, it } from "vitest";
import {
  INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR,
  INCOGNITO_SESSION_UNSUPPORTED_ERROR,
  INCOGNITO_UNSUPPORTED_ERROR,
} from "@zcode/shared";
import { incognitoUnsupportedMessageId } from "../src/lib/incognitoUnsupportedMessage.js";

describe("incognito gate toast", () => {
  it("shows the stale-agent message only for the promptToggles subcode", () => {
    expect(incognitoUnsupportedMessageId(INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR)).toBe(
      "chat.incognito.agentOutdated",
    );
    // The subcode survives a wrapping prefix added by an IPC or RPC layer.
    expect(
      incognitoUnsupportedMessageId(
        `Error invoking remote method 'agent': Error: ${INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR}`,
      ),
    ).toBe("chat.incognito.agentOutdated");
  });

  it("shows the unsupported message for the sessionCapability subcode and the bare code", () => {
    expect(incognitoUnsupportedMessageId(INCOGNITO_SESSION_UNSUPPORTED_ERROR)).toBe(
      "chat.incognito.unsupported",
    );
    expect(incognitoUnsupportedMessageId(INCOGNITO_UNSUPPORTED_ERROR)).toBe(
      "chat.incognito.unsupported",
    );
  });

  it("ignores failures that are not incognito gate failures", () => {
    expect(incognitoUnsupportedMessageId("proto.independentPlanUnsupported")).toBeNull();
    expect(incognitoUnsupportedMessageId("network down")).toBeNull();
  });
});
