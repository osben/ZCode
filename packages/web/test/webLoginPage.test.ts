// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebLoginPage } from "../src/auth/WebLoginPage.js";

describe("mobile remote control login page", () => {
  it("shows the brand and the localized sign-in title", () => {
    document.documentElement.lang = "en-US";
    const html = renderToStaticMarkup(createElement(WebLoginPage, { onLogin: () => {} }));
    expect(html).toContain("ZCode");
    expect(html).toContain("Sign In To Continue");
  });
});
