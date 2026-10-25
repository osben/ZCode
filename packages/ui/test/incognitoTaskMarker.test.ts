import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { IncognitoTaskMarker } from "@/components/IncognitoTaskMarker.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

it("renders an uncolored, labelled marker only for incognito sessions", () => {
  const html = renderToStaticMarkup(
    createElement(IncognitoTaskMarker, { task: { incognito: true } as ZCodeTaskMeta }),
  );
  expect(html).toContain('data-incognito-task-icon="true"');
  expect(html).toContain("taskList.incognitoTaskLabel");
  expect(html).not.toContain("text-incognito");
  expect(
    renderToStaticMarkup(createElement(IncognitoTaskMarker, { task: {} as ZCodeTaskMeta })),
  ).toBe("");
});
