/**
 * Classification of operator transcripts with Jev (TypeSafe AI).
 *
 * Defines the injectable `Classifier` interface, the real implementation on
 * top of the TypeSafe SDK (`JevClassifier`), and the `createClassifier`
 * factory, which returns the mock classifier when `config.jevMock` is true.
 */

import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceQuestion, SystemOneResult } from "@typesafe-ai/sdk";
import { requireTypesafeApiKey } from "./config.js";
import { MockClassifier } from "./mock-jev.js";

/** Possible choice of the traffic question, including the operator's doubt. */
export type TrafficChoice = "low" | "normal" | "high" | "unsure";

/** Normalized result of a traffic classification. */
export interface JevClassification {
  /** Label chosen by the classifier. */
  choice: TrafficChoice;
  /** Probabilities per label, as reported by the model. */
  probabilities: Record<string, number>;
  /** Confidence reported for the chosen label, from 0 to 1. */
  confidence: number;
}

/** Injectable interface: any traffic classifier (real Jev or mock). */
export interface Classifier {
  classify(text: string, currentReplicas: number): Promise<JevClassification>;
}

/** The traffic `choice` question, as sent to the TypeSafe API.
 *  The question is about the OPERATOR'S ORDER on the service's capacity: it
 *  covers both raw emergency orders ("put everything we have") and traffic
 *  descriptions ("we have heavy traffic"). */
const trafficQuestion = choice(
  "Capacity level the operator is asking for the service based on their command: maximum capacity or heavy traffic = high, everything normal = normal, light usage = low",
  {
    low: null,
    normal: null,
    high: null,
    unsure: null,
  },
);

/** Type of the traffic question, useful for building fake clients in tests. */
export type TrafficQuestion = ChoiceQuestion<{
  low: null;
  normal: null;
  high: null;
  unsure: null;
}>;

/** `systemOne` result for the traffic question. */
export type TrafficSystemOneResult = SystemOneResult<{ traffic: TrafficQuestion }>;

/**
 * Minimal SDK client that `JevClassifier` needs. Structurally satisfied by
 * `TypeSafeClient` and by test doubles that never touch the network.
 */
export interface TypeSafeSystemOneClient {
  systemOne(request: {
    state: { operator_command: string; current_replicas: number };
    questions: { traffic: TrafficQuestion };
  }): Promise<TrafficSystemOneResult> | TrafficSystemOneResult;
}

/** Real classifier: asks Jev (TypeSafe AI) with `systemOne`. */
export class JevClassifier implements Classifier {
  private readonly client: TypeSafeSystemOneClient;

  /**
   * @param client TypeSafe client; by default `TypeSafeClient`, which reads
   *   `TYPESAFE_API_KEY` from the environment. Injectable for network-free tests.
   */
  constructor(client: TypeSafeSystemOneClient = new TypeSafeClient()) {
    this.client = client;
  }

  async classify(text: string, currentReplicas: number): Promise<JevClassification> {
    const result = await this.client.systemOne({
      state: { operator_command: text, current_replicas: currentReplicas },
      questions: { traffic: trafficQuestion },
    });
    const answer = result.answers.traffic;
    return {
      choice: answer.choice,
      probabilities: { ...answer.probabilities },
      confidence: answer.confidence,
    };
  }
}

/**
 * Creates the classifier according to the configuration.
 *
 * With `jevMock` true it returns `MockClassifier` (deterministic, no network
 * or key). Otherwise it requires `TYPESAFE_API_KEY` (with the error from
 * `requireTypesafeApiKey`) and returns a real `JevClassifier`.
 */
export function createClassifier(cfg: { jevMock: boolean }): Classifier {
  if (cfg.jevMock) {
    return new MockClassifier();
  }
  requireTypesafeApiKey();
  return new JevClassifier();
}