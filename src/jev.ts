/**
 * Clasificación de transcripciones del operador con Jev (TypeSafe AI).
 *
 * Define la interfaz inyectable `Classifier`, la implementación real sobre el
 * SDK de TypeSafe (`JevClassifier`), y la fábrica `createClassifier`, que
 * devuelve el clasificador mock cuando `config.jevMock` es true.
 */

import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceQuestion, SystemOneResult } from "@typesafe-ai/sdk";
import { requireTypesafeApiKey } from "./config.js";
import { MockClassifier } from "./mock-jev.js";

/** Elección posible de la pregunta de tráfico, incluida la duda del operador. */
export type TraficoChoice = "bajo" | "normal" | "alto" | "no_se";

/** Resultado normalizado de una clasificación de tráfico. */
export interface JevClassification {
  /** Etiqueta elegida por el clasificador. */
  choice: TraficoChoice;
  /** Probabilidades por etiqueta, tal como las reporta el modelo. */
  probabilities: Record<string, number>;
  /** Confianza reportada en la etiqueta elegida, de 0 a 1. */
  confidence: number;
}

/** Interfaz inyectable: cualquier clasificador de tráfico (Jev real o mock). */
export interface Classifier {
  classify(text: string, currentReplicas: number): Promise<JevClassification>;
}

/** Pregunta `choice` de tráfico, tal como se envía a la API de TypeSafe.
 *  La pregunta habla de la ORDEN del operador sobre la capacidad del servicio:
 *  cubre tanto órdenes crudas de emergencia ("pone todo lo que tenemos")
 *  como descripciones de tráfico ("tenemos mucho tráfico"). */
const traficoQuestion = choice(
  "Nivel de capacidad que el operador pide para el servicio según su orden: máxima capacidad o mucho tráfico = alto, todo normal = normal, poco uso = bajo",
  {
  bajo: null,
  normal: null,
  alto: null,
  no_se: null,
});

/** Tipo de la pregunta de tráfico, útil para construir clientes falsos en tests. */
export type TraficoQuestion = ChoiceQuestion<{
  bajo: null;
  normal: null;
  alto: null;
  no_se: null;
}>;

/** Respuesta de `systemOne` para la pregunta de tráfico. */
export type TraficoSystemOneResult = SystemOneResult<{ trafico: TraficoQuestion }>;

/**
 * Cliente SDK mínimo que `JevClassifier` necesita. Estructuralmente satisfecho
 * por `TypeSafeClient` y por los dobles de prueba, que no tocan la red.
 */
export interface TypeSafeSystemOneClient {
  systemOne(request: {
    state: { comando_del_operador: string; replicas_actuales: number };
    questions: { trafico: TraficoQuestion };
  }): Promise<TraficoSystemOneResult> | TraficoSystemOneResult;
}

/** Clasificador real: consulta a Jev (TypeSafe AI) con `systemOne`. */
export class JevClassifier implements Classifier {
  private readonly client: TypeSafeSystemOneClient;

  /**
   * @param client Cliente de TypeSafe; por defecto `TypeSafeClient`, que lee
   *   `TYPESAFE_API_KEY` del entorno. Inyectable para tests sin red.
   */
  constructor(client: TypeSafeSystemOneClient = new TypeSafeClient()) {
    this.client = client;
  }

  async classify(text: string, currentReplicas: number): Promise<JevClassification> {
    const result = await this.client.systemOne({
      state: { comando_del_operador: text, replicas_actuales: currentReplicas },
      questions: { trafico: traficoQuestion },
    });
    const answer = result.answers.trafico;
    return {
      choice: answer.choice,
      probabilities: { ...answer.probabilities },
      confidence: answer.confidence,
    };
  }
}

/**
 * Crea el clasificador según la configuración.
 *
 * Con `jevMock` true devuelve `MockClassifier` (determinista, sin red ni
 * clave). En caso contrario exige `TYPESAFE_API_KEY` (con el error en español
 * de `requireTypesafeApiKey`) y devuelve un `JevClassifier` real.
 */
export function createClassifier(cfg: { jevMock: boolean }): Classifier {
  if (cfg.jevMock) {
    return new MockClassifier();
  }
  requireTypesafeApiKey();
  return new JevClassifier();
}
