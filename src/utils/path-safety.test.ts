import { describe, it, expect } from "vitest";
import { validatePath } from "./path-safety.js";

describe("validatePath", () => {
  const base = "/work/repo";

  it("resolves a relative path inside the base", () => {
    expect(validatePath("src/index.ts", base)).toBe("/work/repo/src/index.ts");
  });

  it("allows the base directory itself", () => {
    expect(validatePath(".", base)).toBe("/work/repo");
  });

  it("rejects parent traversal", () => {
    expect(() => validatePath("../../etc/passwd", base)).toThrow(
      /Path traversal/
    );
  });

  it("rejects absolute paths outside the base", () => {
    expect(() => validatePath("/etc/passwd", base)).toThrow(/Path traversal/);
  });

  it("rejects a sibling directory sharing the base prefix", () => {
    expect(() => validatePath("../repo-evil/file", base)).toThrow(
      /Path traversal/
    );
  });
});
