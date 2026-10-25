import { describe, expect, it } from "vitest";
import {
  buildOAuthCallbackPage,
  isSafeAppUrl,
  renderOAuthCallbackPage,
} from "../src/node/oauthCallbackPage.js";

describe("OAuth callback page", () => {
  it("renders success with an Open ZCode link and nonce-bound CSP", () => {
    const page = renderOAuthCallbackPage(
      buildOAuthCallbackPage("success", { flow: "sign-in", surface: "app" }),
    );
    expect(page.html).toContain('href="zcode://"');
    expect(page.html).toContain("Open ZCode");
    const nonce = /style nonce="([^"]+)"/u.exec(page.html)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.contentSecurityPolicy).toContain(`'nonce-${nonce}'`);
    expect(page.contentSecurityPolicy).toContain("default-src 'none'");
  });

  it("omits the app button on the CLI surface", () => {
    const page = renderOAuthCallbackPage(
      buildOAuthCallbackPage("success", { flow: "sign-in", surface: "cli" }),
    );
    expect(page.html).not.toContain("Open ZCode");
    expect(page.html).toContain("terminal");
  });

  it("escapes provider-supplied detail", () => {
    const page = renderOAuthCallbackPage(
      buildOAuthCallbackPage("denied", {
        flow: "sign-in",
        surface: "app",
        detail: '<script>alert("x")</script>',
      }),
    );
    expect(page.html).not.toContain("<script>alert");
    expect(page.html).toContain("&lt;script&gt;");
  });

  it("rejects unsafe app URLs", () => {
    expect(isSafeAppUrl("zcode://")).toBe(true);
    for (const href of [
      "javascript:alert(1)",
      "https://evil.test",
      "data:text/html,x",
      "zcode://a b",
    ]) {
      expect(isSafeAppUrl(href)).toBe(false);
    }
    const page = renderOAuthCallbackPage(
      buildOAuthCallbackPage("success", {
        flow: "usage-link",
        surface: "app",
        appUrl: "javascript:alert(1)",
      }),
    );
    expect(page.html).not.toContain("javascript:");
  });

  it("uses error styling for invalid and failed outcomes", () => {
    for (const outcome of ["invalid", "failed", "denied"] as const) {
      const page = renderOAuthCallbackPage(
        buildOAuthCallbackPage(outcome, { flow: "usage-link", surface: "app" }),
      );
      expect(page.html).toContain('class="error"');
    }
  });
});
