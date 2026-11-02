/**
 * Deterministic mock classifier for demos and tests without network access.
 *
 * Replaces Jev with a keyword heuristic: lowercase, diacritics stripped, with
 * a fixed evaluation order (high → normal → low → unsure) so the same phrase
 * always produces the same classification.
 */

import type { Classifier, JevClassification, TrafficChoice } from "./jev.js";

/** Plausible distributions per choice: peak = confidence, sum ≈ 1. */
const DISTRIBUTIONS: Record<
  TrafficChoice,
  { confidence: number; probabilities: Record<TrafficChoice, number> }
> = {
  high: { confidence: 0.92, probabilities: { high: 0.92, normal: 0.05, low: 0.02, unsure: 0.01 } },
  normal: { confidence: 0.9, probabilities: { high: 0.06, normal: 0.9, low: 0.03, unsure: 0.01 } },
  low: { confidence: 0.9, probabilities: { high: 0.03, normal: 0.06, low: 0.9, unsure: 0.01 } },
  unsure: { confidence: 0.3, probabilities: { high: 0.2, normal: 0.25, low: 0.25, unsure: 0.3 } },
};

/** Keywords per level, evaluated in this order (high → normal → low).
 *  Each keyword is matched as a WORD START (left-anchored word boundary:
 *  `\b<keyword>`, with the keyword escaped). The left anchor keeps prefixes
 *  working ("\bsaturat" still matches "saturated") but blocks substring
 *  collisions: "unstable" no longer matches "\bstable" (there is no word
 *  boundary before "stable" inside "unstable").
 *  high covers traffic descriptions ("a lot", "saturated", "peak") and raw
 *  movie-style emergency orders ("everything we have", "thrusters", "all the
 *  power", "max"). WARNING: NEVER add the word "power" alone to high (it
 *  would steal "little power available" → must be low), nor the word
 *  "everything" alone (it would steal "everything is back to normal", which
 *  falls under normal via "normal"). Also never add "no" to low: as a
 *  left-anchored prefix it would steal "normal". */
const KEYWORDS: ReadonlyArray<{ choice: Exclude<TrafficChoice, "unsure">; words: readonly string[] }> = [
  { choice: "high", words: ["a lot", "high", "saturat", "peak", "everything we have", "thruster", "all the power", "max"] },
  { choice: "normal", words: ["normal", "usual", "stable", "chill", "calm"] },
  // "little" (\b-anchored) covers little-traffic and low-capacity phrases.
  { choice: "low", words: ["little", "low", "nothing", "without"] },
];

/** Lowercase, diacritics stripped (NFD + removal of combining marks). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Matches `word` as a word start in `text` (`\b` + escaped keyword).
 *  The keyword is already normalized (lowercase, no diacritics), so the regex
 *  only needs to escape regex special characters. */
function matchesAtWordBoundary(text: string, word: string): boolean {
  return new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(text);
}

/** Deterministic offline classifier: keyword heuristic. */
export class MockClassifier implements Classifier {
  async classify(text: string, _currentReplicas: number): Promise<JevClassification> {
    const normalized = normalize(text);
    let choice: TrafficChoice = "unsure";
    for (const { choice: level, words } of KEYWORDS) {
      if (words.some((word) => matchesAtWordBoundary(normalized, word))) {
        choice = level;
        break;
      }
    }
    const { confidence, probabilities } = DISTRIBUTIONS[choice];
    return { choice, probabilities: { ...probabilities }, confidence };
  }
}