import { describe, expect, it } from "vitest";
import { readHttpEntryEnv } from "../src/entryHttpEnv.js";

describe("readHttpEntryEnv", () => {
  it("defaults to port 3030 with no host, token, or static root", () => {
    expect(readHttpEntryEnv({})).toEqual({ port: 3030 });
  });

  it("prefers ZCODE_SERVER_HOST over HOST and trims values", () => {
    expect(
      readHttpEntryEnv({ ZCODE_SERVER_HOST: " 127.0.0.1 ", HOST: "my-machine.local" }),
    ).toMatchObject({ host: "127.0.0.1" });
  });

  it("falls back to HOST when ZCODE_SERVER_HOST is blank", () => {
    expect(readHttpEntryEnv({ ZCODE_SERVER_HOST: "  ", HOST: "0.0.0.0" })).toMatchObject({
      host: "0.0.0.0",
    });
  });

  it("maps the auth token, static root, and port", () => {
    expect(
      readHttpEntryEnv({
        PORT: "4040",
        ZCODE_SERVER_AUTH_TOKEN: " secret ",
        ZCODE_WEB_STATIC_ROOT: "/srv/web",
        ZCODE_SERVER_TOKEN: "ignored",
      }),
    ).toEqual({ port: 4040, authToken: "secret", staticRoot: "/srv/web" });
  });
});
