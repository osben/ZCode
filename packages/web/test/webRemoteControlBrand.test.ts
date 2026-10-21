import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebRemoteControlBrand } from "#src/web-remote-control/views.js";

describe("remote-control page header brand", () => {
  it("the brand icon is decorative, and the whole header is not interactive", () => {
    const html = renderToStaticMarkup(createElement(WebRemoteControlBrand));
    expect(html).toMatch(/<img[^>]*data-app-logo="zcode"/);
    expect(html).toMatch(/<img[^>]*alt=""/);
    expect(html).toMatch(/<img[^>]*aria-hidden="true"/);
    expect(html).toContain("ZCode");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("role=");
  });
});
