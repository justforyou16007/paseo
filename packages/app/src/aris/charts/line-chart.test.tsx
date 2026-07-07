/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from "vitest";
import { getArisSeriesColor, ARIS_CATEGORICAL_PALETTE } from "./color-palette";

describe("aris chart color palette", () => {
  test("returns palette colors in fixed order", () => {
    expect(getArisSeriesColor(0)).toBe(ARIS_CATEGORICAL_PALETTE[0]);
    expect(getArisSeriesColor(1)).toBe(ARIS_CATEGORICAL_PALETTE[1]);
  });

  test("wraps around when index exceeds palette length", () => {
    expect(getArisSeriesColor(ARIS_CATEGORICAL_PALETTE.length)).toBe(ARIS_CATEGORICAL_PALETTE[0]);
  });
});
