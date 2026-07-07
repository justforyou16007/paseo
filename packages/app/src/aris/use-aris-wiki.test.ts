import { describe, expect, test } from "vitest";
import { arisWikiQueryKey } from "./query-keys";

describe("arisWikiQueryKey", () => {
  test("includes serverId and cwd", () => {
    expect(arisWikiQueryKey("server-1", "/workspace")).toEqual([
      "aris",
      "wiki",
      "server-1",
      "/workspace",
    ]);
  });

  test("falls back to empty strings for null inputs", () => {
    expect(arisWikiQueryKey(null, null)).toEqual(["aris", "wiki", "", ""]);
  });
});
