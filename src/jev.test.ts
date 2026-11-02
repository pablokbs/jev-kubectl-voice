/**
 * Tests of the Jev classification domain.
 *
 * - `JevClassifier` against a FAKE injected SDK client (no network, the real
 *   `TypeSafeClient` is never imported): verifies the SDK response mapping to
 *   `JevClassification` and the request sent.
 * - `MockClassifier` via `createClassifier({ jevMock: true })`: English demo phrases.
 * - `createClassifier`: mock/real selection and the error without a key.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createClassifier,
  JevClassifier,
  type TrafficChoice,
  type TrafficSystemOneResult,
  type TypeSafeSystemOneClient,
} from "./jev.js";
import { MockClassifier } from "./mock-jev.js";

/** Fake SDK client: records the request and returns a fixed answer. */
class FakeSdkClient implements TypeSafeSystemOneClient {
  lastRequest: Parameters<TypeSafeSystemOneClient["systemOne"]>[0] | undefined;

  constructor(
    private readonly answer: {
      choice: TrafficChoice;
      confidence: number;
      probabilities: Record<TrafficChoice, number>;
    },
  ) {}

  systemOne(
    request: Parameters<TypeSafeSystemOneClient["systemOne"]>[0],
  ): Promise<TrafficSystemOneResult> {
    this.lastRequest = request;
    const result: TrafficSystemOneResult = {
      model: "jev-fake",
      usage: { input_tokens: null, output_tokens: null },
      answers: {
        traffic: {
          type: "choice",
          choice: this.answer.choice,
          confidence: this.answer.confidence,
          probabilities: this.answer.probabilities,
        },
      },
    };
    return Promise.resolve(result);
  }
}

describe("JevClassifier", () => {
  it("maps the SDK response to JevClassification and sends the correct state and question", async () => {
    const fake = new FakeSdkClient({
      choice: "high",
      confidence: 0.87,
      probabilities: { high: 0.87, normal: 0.07, low: 0.04, unsure: 0.02 },
    });
    const classifier = new JevClassifier(fake);

    const result = await classifier.classify("we have a lot of traffic", 3);

    // Normalized response, a flat typed object.
    assert.deepStrictEqual(result, {
      choice: "high",
      probabilities: { high: 0.87, normal: 0.07, low: 0.04, unsure: 0.02 },
      confidence: 0.87,
    });

    // Request towards the SDK: state with command and current replicas.
    assert.ok(fake.lastRequest, "the classifier must call systemOne");
    assert.deepStrictEqual(fake.lastRequest.state, {
      operator_command: "we have a lot of traffic",
      current_replicas: 3,
    });

    // The traffic `choice` question with the four labels and the instructions
    // that frame the operator's order (requested capacity, not just traffic).
    assert.deepStrictEqual(fake.lastRequest.questions.traffic, {
      type: "choice",
      instructions:
        "Capacity level the operator is asking for the service based on their command: maximum capacity or heavy traffic = high, everything normal = normal, light usage = low",
      criteria: { low: null, normal: null, high: null, unsure: null },
    });
  });

  it("propagates the SDK rejection (network or API error)", async () => {
    const failing: TypeSafeSystemOneClient = {
      systemOne() {
        return Promise.reject(new Error("simulated network failure"));
      },
    };
    const classifier = new JevClassifier(failing);
    await assert.rejects(classifier.classify("heavy traffic", 3), /simulated network failure/);
  });
});

describe("createClassifier with jevMock true (MockClassifier)", () => {
  const classifier = createClassifier({ jevMock: true });

  it("returns a MockClassifier", () => {
    assert.ok(classifier instanceof MockClassifier);
  });

  // Table: English demo phrases → expected level. Includes the traffic
  // classics and the raw movie-style orders (hero → their AI).
  const phraseCases: ReadonlyArray<{ text: string; choice: TrafficChoice; confidence: number }> = [
    { text: "we have a lot of traffic", choice: "high", confidence: 0.92 },
    { text: "the traffic is normal", choice: "normal", confidence: 0.9 },
    { text: "there is little traffic", choice: "low", confidence: 0.9 },
    { text: "today is tuesday", choice: "unsure", confidence: 0.3 },
    { text: "put everything we have into the cluster", choice: "high", confidence: 0.92 },
    { text: "put everything we have into the thrusters", choice: "high", confidence: 0.92 },
    { text: "everything is back to normal", choice: "normal", confidence: 0.9 },
    // Substring-collision regressions: "little power" must not scale to high
    // via the word "power", and "unstable" must not match "stable".
    { text: "we have little power available", choice: "low", confidence: 0.9 },
    { text: "the service is unstable", choice: "unsure", confidence: 0.3 },
    { text: "we have little power, we're toast", choice: "low", confidence: 0.9 },
  ];

  for (const { text, choice, confidence } of phraseCases) {
    it(`classifies "${text}" as ${choice} (confidence ${confidence})`, async () => {
      const result = await classifier.classify(text, 3);
      assert.equal(result.choice, choice);
      assert.equal(result.confidence, confidence);
    });
  }

  it("normalizes case and diacritics", async () => {
    const upper = await classifier.classify("HIGH TRAFFIC", 1);
    assert.equal(upper.choice, "high");
    // Diacritics are stripped before matching (NFD), so accented input still
    // classifies: "saturatéd" normalizes to "saturated".
    const accented = await classifier.classify("saturatéd", 1);
    assert.equal(accented.choice, "high");
  });

  it("uses other keywords of the expected lexicon", async () => {
    assert.equal((await classifier.classify("the traffic peak has passed", 2)).choice, "high");
    assert.equal((await classifier.classify("stable load this afternoon", 2)).choice, "normal");
    assert.equal((await classifier.classify("almost without traffic right now", 2)).choice, "low");
  });

  it("returns plausible probabilities: peak = confidence and sum ≈ 1", async () => {
    for (const { text, choice, confidence } of phraseCases) {
      const result = await classifier.classify(text, 3);
      const total = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(
        Math.abs(total - 1) < 1e-9,
        `probabilities of "${text}" must sum to ≈ 1, got ${total}`,
      );
      assert.equal(result.probabilities[choice], confidence);
    }
  });

  it("ignores the current replicas: the heuristic is deterministic", async () => {
    const withReplicas = await classifier.classify("traffic normal", 6);
    const withoutReplicas = await classifier.classify("traffic normal", 0);
    assert.deepStrictEqual(withReplicas, withoutReplicas);
  });
});

describe("createClassifier", () => {
  const previousKey = process.env.TYPESAFE_API_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = previousKey;
    }
  });

  it("returns a JevClassifier when jevMock is false and an API key exists", () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const classifier = createClassifier({ jevMock: false });
    assert.ok(classifier instanceof JevClassifier);
    assert.ok(typeof classifier.classify === "function");
  });

  it("throws the requireTypesafeApiKey error when jevMock is false and the key is missing", () => {
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => createClassifier({ jevMock: false }), /TYPESAFE_API_KEY/);
  });
});