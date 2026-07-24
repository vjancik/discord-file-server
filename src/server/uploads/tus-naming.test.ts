import { describe, expect, test } from "bun:test";
import { stagingNamingFunction } from "./tus";

const HEX32 = /^[0-9a-f]{32}$/;

describe("stagingNamingFunction", () => {
  test("appends the source extension to a random hex id", () => {
    const name = stagingNamingFunction({ filename: "poster.jpg" });
    const [id, ext] = name.split(".");
    expect(id).toMatch(HEX32);
    expect(ext).toBe("jpg");
  });

  test("lowercases the extension", () => {
    expect(stagingNamingFunction({ filename: "IMG.JPEG" })).toMatch(
      /^[0-9a-f]{32}\.jpeg$/,
    );
  });

  test("no extension → bare id, no trailing dot", () => {
    for (const filename of ["README", "archive.", ".gitignore", undefined]) {
      const name = stagingNamingFunction(
        filename === undefined ? {} : { filename },
      );
      expect(name).toMatch(HEX32);
      expect(name).not.toContain(".");
    }
  });

  test("preserves a .json extension (round-trips as a data file)", () => {
    expect(stagingNamingFunction({ filename: "notes.json" })).toMatch(
      /^[0-9a-f]{32}\.json$/,
    );
  });

  test("sanitizes separators and control chars out of the extension", () => {
    // An extension the untrusted client filename could smuggle in must never
    // carry a path separator, dot, or other unsafe character into the path.
    const name = stagingNamingFunction({ filename: "evil.tar/../../etc" });
    const ext = name.split(".")[1] ?? "";
    expect(ext).toMatch(/^[a-z0-9]*$/);
    expect(name).not.toContain("/");
  });

  test("caps an absurdly long extension", () => {
    const name = stagingNamingFunction({ filename: `x.${"a".repeat(200)}` });
    const ext = name.split(".")[1] ?? "";
    expect(ext.length).toBeLessThanOrEqual(12);
  });

  test("ids are unique across calls", () => {
    const a = stagingNamingFunction({ filename: "a.png" });
    const b = stagingNamingFunction({ filename: "a.png" });
    expect(a).not.toBe(b);
  });
});
