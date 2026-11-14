import { describe, expect, it } from "vitest";
import { escapePowerShellLiteral } from "../scripts/powershell-command.mjs";

// Upstream 3.18.2 (reconstructed): signature query paths go into the script as single-quoted literals.
describe("escapePowerShellLiteral", () => {
  it("wraps a plain path in single quotes", () => {
    expect(escapePowerShellLiteral("C:\\Program Files\\ZCode\\ZCode.exe")).toBe(
      "'C:\\Program Files\\ZCode\\ZCode.exe'",
    );
  });

  it("doubles straight and smart single quotes, which PowerShell treats as quote characters", () => {
    expect(escapePowerShellLiteral("a'b\u2018c\u2019d\u201Ae\u201Bf")).toBe(
      "'a''b\u2018\u2018c\u2019\u2019d\u201A\u201Ae\u201B\u201Bf'",
    );
  });

  it("leaves script metacharacters inert inside the literal", () => {
    expect(escapePowerShellLiteral("x;$(calc)`&")).toBe("'x;$(calc)`&'");
  });

  it.each(["a\0b", "a\rb", "a\nb"])("rejects control characters: %j", (value) => {
    expect(() => escapePowerShellLiteral(value)).toThrow(
      "PowerShell path literal cannot contain NUL or newline characters",
    );
  });
});
