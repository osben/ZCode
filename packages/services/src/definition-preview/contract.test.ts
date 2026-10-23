import { definitionPreviewReadParamsSchema } from "@zcode/shared/definition-preview";
import { describe, expect, it } from "vitest";
import { exampleDefinitionPreviewReadParams } from "./contract.example.js";
import { DEFINITION_PREVIEW_CHANNEL, IDefinitionPreviewService } from "./contract.js";

describe("definition-preview-service contract", () => {
  it("binds the service descriptor to the literal definition-preview channel", () => {
    expect(IDefinitionPreviewService.channelName).toBe(DEFINITION_PREVIEW_CHANNEL);
    expect(DEFINITION_PREVIEW_CHANNEL).toBe("definition-preview");
  });

  it("provides read params that satisfy the wire schema", () => {
    expect(definitionPreviewReadParamsSchema.parse(exampleDefinitionPreviewReadParams)).toEqual(
      exampleDefinitionPreviewReadParams,
    );
  });
});
