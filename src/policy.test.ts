/**
 * Tests of the pure decision policy (`decideAction`).
 *
 * Case table: level-to-replicas mapping, skip on `unsure`, skip on low
 * confidence and the boundary case confidence == threshold.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAction } from "./policy.js";
import type { JevClassification } from "./jev.js";
import type { TrafficLevel } from "./config.js";

const THRESHOLD = 0.5;
const REPLICAS: Readonly<Record<TrafficLevel, number>> = {
  low: 1,
  normal: 3,
  high: 10,
};

function classificationOf(choice: JevClassification["choice"], confidence: number): JevClassification {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

describe("decideAction", () => {
  // Table: each level with confidence above the threshold scales to the given map.
  const scaleCases: ReadonlyArray<{
    choice: Exclude<JevClassification["choice"], "unsure">;
    confidence: number;
    replicas: number;
  }> = [
    { choice: "low", confidence: 0.99, replicas: 1 },
    { choice: "normal", confidence: 0.8, replicas: 3 },
    { choice: "high", confidence: 0.6, replicas: 10 },
  ];

  for (const { choice, confidence, replicas } of scaleCases) {
    it(`scales "${choice}" to ${replicas} replicas with confidence ${confidence} >= threshold ${THRESHOLD}`, () => {
      const action = decideAction(
        classificationOf(choice, confidence),
        REPLICAS,
        THRESHOLD,
      );
      assert.deepStrictEqual(action, { type: "scale", replicas });
    });
  }

  it("uses the received replicas map, not an internal constant", () => {
    const customMap = { low: 2, normal: 4, high: 8 };
    const action = decideAction(classificationOf("normal", 0.9), customMap, THRESHOLD);
    assert.deepStrictEqual(action, { type: "scale", replicas: 4 });
  });

  it("skips the adjustment when the choice is unsure, even with high confidence", () => {
    const action = decideAction(classificationOf("unsure", 0.99), REPLICAS, THRESHOLD);
    assert.equal(action.type, "skip");
    assert.ok(
      action.type === "skip" && /unsure/i.test(action.reason),
      `the reason must mention unsure, got: ${action.type === "skip" ? action.reason : "scaling action"}`,
    );
  });

  it("skips the adjustment when confidence 0.49 is below the threshold 0.5", () => {
    const action = decideAction(classificationOf("high", 0.49), REPLICAS, THRESHOLD);
    assert.equal(action.type, "skip");
    assert.ok(action.type === "skip" && action.reason.includes("0.49"), "the reason must include the confidence 0.49");
    assert.ok(action.type === "skip" && action.reason.includes("0.50"), "the reason must include the threshold 0.50");
  });

  it("scales at the exact boundary: confidence == threshold (>= comparison)", () => {
    const action = decideAction(classificationOf("high", 0.5), REPLICAS, 0.5);
    assert.deepStrictEqual(action, { type: "scale", replicas: 10 });
  });

  it("skips with confidence below the threshold for any level", () => {
    for (const choice of ["low", "normal", "high"] as const) {
      const action = decideAction(classificationOf(choice, 0.1), REPLICAS, 0.5);
      assert.equal(action.type, "skip", `level ${choice} should skip with confidence 0.1`);
    }
  });
});