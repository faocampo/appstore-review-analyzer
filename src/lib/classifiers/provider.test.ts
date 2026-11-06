import { describe, expect, it } from "vitest";

import {
  buildClassification,
  delay,
  errorMessage,
  isReason,
  validDistribution,
} from "@/lib/classifiers/provider";
import { MOCK_INFO } from "@/lib/classifiers/mock";

describe("classifier helpers", () => {
  it("validates and normalizes distributions", () => {
    expect(validDistribution(["a", "b"], { a: 0.49, b: 0.49 })).toEqual({
      a: 0.5,
      b: 0.5,
    });
    expect(validDistribution(["a", "b"], { a: 1 })).toBeNull();
    expect(validDistribution(["a", "b"], { a: -0.5, b: 1.5 })).toBeNull();
    expect(validDistribution(["a", "b"], { a: 0.2, b: 0.2 })).toBeNull();
  });

  it("clamps scores and confidences into range", () => {
    const result = buildClassification({
      info: MOCK_INFO,
      providerScore: 7,
      sentimentProbabilities: null,
      sentimentConfidence: 2,
      primaryReason: "ads",
      reasonProbabilities: null,
      reasonConfidence: -1,
    });

    expect(result.sentimentExpectedValue).toBe(4);
    expect(result.sentimentLabel).toBe("highly_positive");
    expect(result.sentimentConfidence).toBe(1);
    expect(result.reasonConfidence).toBe(0);
  });

  it("recognizes taxonomy reasons and formats unknown errors", async () => {
    expect(isReason("ads")).toBe(true);
    expect(isReason("toString")).toBe(false);
    expect(errorMessage("boom")).toBe("classification failed");
    await expect(delay(1)).resolves.toBeUndefined();
  });
});
