import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRegistryProviderConfig, parseProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const OPTIONS = { reasoningLevel: "medium", maxOutputTokens: 128000 };

function createSiwcFixture() {
  const requests: Request[] = [];
  const execution = new AiSdkModelExecution(
    { env: {} },
    {
      transport: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(
          { error: { code: "subscription_sharing_user_not_eligible", message: "captured" } },
          { status: 403 },
        );
      },
    },
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "chatgpt-family",
      access: { type: "chatgpt-account", entitled: true },
      api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
    }),
  );
  if (!provider.ok) throw new Error("invalid chatgpt fixture");
  const bound = execution.bindModel({
    providerId: "account:chatgpt-plan",
    modelId: "gpt-6.1-sol",
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      // The option map injects max_output_tokens from the catalog-style rule; the SIWC compat
      // layer must strip it AFTER this wrapper runs.
      reasoningLevel: { map: "{'reasoning': {'effort': reasoningLevel}}" },
      maxOutputTokens: { map: "{'max_output_tokens': maxOutputTokens}" },
    },
  });
  return { bound, requests };
}

describe("ChatGPT plan openai-responses wire (SIWC)", () => {
  it("sends store:false/stream:true, strips option-map fields, and uses the SIWC access token", async () => {
    const { bound, requests } = createSiwcFixture();
    const model = bound.resolveRequest({
      options: OPTIONS,
      requestAuth: { apiKey: "siwc-access-token" },
    }).model;
    await expect(generateText({ model, prompt: "test", maxRetries: 0 })).rejects.toThrow();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.openai.com/v1/responses");
    expect(request.headers.get("authorization")).toBe("Bearer siwc-access-token");

    const body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("gpt-6.1-sol");
    // Injected by the option map from request options, then stripped by the SIWC layer.
    expect("max_output_tokens" in body).toBe(false);
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    // The system prompt rides in instructions, never as a system-role input item.
    expect(String(body.instructions).length).toBeGreaterThan(0);
    const input = body.input as { role?: string }[];
    expect(input.some((item) => item.role === "system")).toBe(false);
  });

  it("binds providerOptions.openai.store=false for the SDK reasoning-encrypted-content default", () => {
    const { bound } = createSiwcFixture();
    const resolved = bound.resolveRequest({ options: OPTIONS, requestAuth: undefined });
    const openaiOptions = resolved.providerOptions?.openai as { store?: unknown } | undefined;
    expect(openaiOptions?.store).toBe(false);
  });
});
