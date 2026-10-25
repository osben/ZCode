import { describe, expect, it } from "vitest";
import { exampleDefinitionPreviewRead, exampleDefinitionPreviewRef } from "./contract.example.js";
import { definitionPreviewReadParamsSchema, definitionPreviewRefSchema } from "./contract.js";

describe("definition-preview-protocol contract", () => {
  it("accepts the example ref and read params", () => {
    expect(definitionPreviewRefSchema.parse(exampleDefinitionPreviewRef)).toEqual(
      exampleDefinitionPreviewRef,
    );
    expect(definitionPreviewReadParamsSchema.parse(exampleDefinitionPreviewRead)).toEqual(
      exampleDefinitionPreviewRead,
    );
  });

  it("rejects unknown kinds, blank names and extra fields such as a client-chosen root", () => {
    expect(
      definitionPreviewRefSchema.safeParse({ ...exampleDefinitionPreviewRef, kind: "file" })
        .success,
    ).toBe(false);
    expect(
      definitionPreviewRefSchema.safeParse({ ...exampleDefinitionPreviewRef, name: "  " }).success,
    ).toBe(false);
    expect(
      definitionPreviewRefSchema.safeParse({ ...exampleDefinitionPreviewRef, root: "/etc" })
        .success,
    ).toBe(false);
  });
});
