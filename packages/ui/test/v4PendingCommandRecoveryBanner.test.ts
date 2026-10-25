import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PendingCommandRecoveryBanner } from "@/v4/PendingCommandRecoveryBanner.js";
import type { PendingCommandEntry } from "@/v4/pendingCommandRegistry.js";
import { expectedCopy } from "./helpers/uiCopy.js";

function render(entry: PendingCommandEntry): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PendingCommandRecoveryBanner, {
        entry,
        onResend: entry.replay.kind === "input" ? vi.fn() : undefined,
        onDismiss: vi.fn(),
      }),
    ),
  );
}

describe("PendingCommandRecoveryBanner", () => {
  it("offers an explicit resend button for discarded plain input", () => {
    const html = render({
      commandId: "command-1",
      clientId: "client-1",
      sessionId: "session-1",
      issuedAt: 1,
      expiresAt: 2,
      recovery: "discarded",
      replay: { kind: "input", type: "sendText", payload: { text: "hello" } },
    });
    expect(html).toContain(expectedCopy("chat.pendingCommand.discarded"));
    expect(html).toContain(expectedCopy("chat.pendingCommand.resend"));
  });
});
