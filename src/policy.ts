/**
 * Pure decision policy: converts a traffic classification into the action to
 * run (scale to N replicas or skip the adjustment).
 *
 * It knows neither Kubernetes nor the classifier: it is a pure, trivially
 * testable function.
 */

import type { JevClassification, TrafficChoice } from "./jev.js";
import type { TrafficLevel } from "./config.js";

/** Resulting policy action. */
export type PolicyAction =
  | { type: "scale"; replicas: number }
  | { type: "skip"; reason: string };

/** Map of target replicas per traffic level (low/normal/high). */
export type ReplicasMap = Readonly<Record<TrafficLevel, number>>;

/**
 * Decides the action from the classification.
 *
 * - `unsure`: skip (the operator is not sure).
 * - Confidence below the threshold: skip (strict `<` comparison; at the exact
 *   boundary, confidence == threshold, it scales).
 * - Otherwise: scale to `replicasMap[choice]`.
 */
export function decideAction(
  classification: JevClassification,
  replicasMap: ReplicasMap,
  threshold: number,
): PolicyAction {
  if (classification.choice === "unsure") {
    return {
      type: "skip",
      reason:
        "The operator is not sure about the traffic level (unsure); no replicas are adjusted.",
    };
  }

  const choice: Exclude<TrafficChoice, "unsure"> = classification.choice;
  if (classification.confidence < threshold) {
    return {
      type: "skip",
      reason:
        `Confidence ${classification.confidence.toFixed(2)} is below the threshold ` +
        `${threshold.toFixed(2)} for "${choice}"; no replicas are adjusted.`,
    };
  }

  return { type: "scale", replicas: replicasMap[choice] };
}