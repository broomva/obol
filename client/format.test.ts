import { describe, expect, it } from "vitest";
import { formatCost, formatPercent, formatResetsAt, formatTokens } from "./format";

describe("formatTokens", () => {
  it("keeps small counts exact", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("switches units at each threshold", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(999_999)).toBe("1000.0k");
    expect(formatTokens(1_234_567)).toBe("1.23M");
  });
});

describe("formatCost", () => {
  // "not reported" and "$0.00" are different claims and must not collapse.
  it("distinguishes an unreported cost from a zero cost", () => {
    expect(formatCost(null)).toBe("not reported");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("renders two decimals", () => {
    expect(formatCost(3.756)).toBe("$3.76");
  });
});

describe("formatPercent", () => {
  it("renders a dash when there is no value", () => {
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(22.5)).toBe("23%");
  });
});

describe("formatResetsAt", () => {
  const now = Date.parse("2026-09-08T12:00:00Z");

  it("is empty for a missing or unparseable instant", () => {
    expect(formatResetsAt(null, now)).toBe("");
    expect(formatResetsAt("not a date", now)).toBe("");
  });

  it("reports minutes, hours and days", () => {
    expect(formatResetsAt("2026-09-08T12:45:00Z", now)).toBe("resets in 45m");
    expect(formatResetsAt("2026-09-08T14:15:00Z", now)).toBe("resets in 2h 15m");
    expect(formatResetsAt("2026-09-10T15:00:00Z", now)).toBe("resets in 2d 3h");
  });

  it("does not render a negative countdown for a window that already reset", () => {
    expect(formatResetsAt("2026-09-08T11:00:00Z", now)).toBe("resets now");
  });
});
