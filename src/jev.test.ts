/**
 * Tests del dominio de clasificación Jev.
 *
 * - `JevClassifier` contra un cliente SDK FALSO inyectado (sin red, sin
 *   importar el `TypeSafeClient` real): verifica el mapeo de la respuesta del
 *   SDK a `JevClassification` y la petición enviada.
 * - `MockClassifier` vía `createClassifier({ jevMock: true })`: frases en
 *   español de la demo.
 * - `createClassifier`: selección de mock/real y error en español sin clave.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createClassifier,
  JevClassifier,
  type TraficoChoice,
  type TraficoSystemOneResult,
  type TypeSafeSystemOneClient,
} from "./jev.js";
import { MockClassifier } from "./mock-jev.js";

/** Cliente SDK falso: registra la petición y devuelve una respuesta fija. */
class FakeSdkClient implements TypeSafeSystemOneClient {
  lastRequest: Parameters<TypeSafeSystemOneClient["systemOne"]>[0] | undefined;

  constructor(
    private readonly answer: {
      choice: TraficoChoice;
      confidence: number;
      probabilities: Record<TraficoChoice, number>;
    },
  ) {}

  systemOne(
    request: Parameters<TypeSafeSystemOneClient["systemOne"]>[0],
  ): Promise<TraficoSystemOneResult> {
    this.lastRequest = request;
    const result: TraficoSystemOneResult = {
      model: "jev-fake",
      usage: { input_tokens: null, output_tokens: null },
      answers: {
        trafico: {
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
  it("mapea la respuesta del SDK a JevClassification y envía state y question correctos", async () => {
    const fake = new FakeSdkClient({
      choice: "alto",
      confidence: 0.87,
      probabilities: { alto: 0.87, normal: 0.07, bajo: 0.04, no_se: 0.02 },
    });
    const classifier = new JevClassifier(fake);

    const result = await classifier.classify("hay mucho tráfico", 3);

    // Respuesta normalizada, un objeto plano tipado.
    assert.deepStrictEqual(result, {
      choice: "alto",
      probabilities: { alto: 0.87, normal: 0.07, bajo: 0.04, no_se: 0.02 },
      confidence: 0.87,
    });

    // Petición hacia el SDK: estado con comando y réplicas actuales.
    assert.ok(fake.lastRequest, "el clasificador debe llamar a systemOne");
    assert.deepStrictEqual(fake.lastRequest.state, {
      comando_del_operador: "hay mucho tráfico",
      replicas_actuales: 3,
    });

    // Pregunta `choice` de tráfico con las cuatro etiquetas y las instrucciones
    // que enmarcan la orden del operador (capacidad pedida, no solo tráfico).
    assert.deepStrictEqual(fake.lastRequest.questions.trafico, {
      type: "choice",
      instructions:
        "Nivel de capacidad que el operador pide para el servicio según su orden: máxima capacidad o mucho tráfico = alto, todo normal = normal, poco uso = bajo",
      criteria: { bajo: null, normal: null, alto: null, no_se: null },
    });
  });

  it("propaga el rechazo del SDK (error de red o de API)", async () => {
    const failing: TypeSafeSystemOneClient = {
      systemOne() {
        return Promise.reject(new Error("fallo de red simulado"));
      },
    };
    const classifier = new JevClassifier(failing);
    await assert.rejects(classifier.classify("mucho tráfico", 3), /fallo de red simulado/);
  });
});

describe("createClassifier con jevMock true (MockClassifier)", () => {
  const classifier = createClassifier({ jevMock: true });

  it("devuelve un MockClassifier", () => {
    assert.ok(classifier instanceof MockClassifier);
  });

  // Tabla: frases de la demo en español → nivel esperado. Incluye los clásicos
  // de tráfico y las órdenes crudas de la nueva narrativa (héroe → su IA).
  const phraseCases: ReadonlyArray<{ text: string; choice: TraficoChoice; confidence: number }> = [
    { text: "tenemos mucho tráfico", choice: "alto", confidence: 0.92 },
    { text: "el tráfico es normal", choice: "normal", confidence: 0.9 },
    { text: "hay poco tráfico", choice: "bajo", confidence: 0.9 },
    { text: "hoy es martes", choice: "no_se", confidence: 0.3 },
    { text: "pone todo lo que tenemos en el cluster", choice: "alto", confidence: 0.92 },
    { text: "poné todo lo que tenemos en los propulsores", choice: "alto", confidence: 0.92 },
    { text: "ya está todo normal", choice: "normal", confidence: 0.9 },
    // Regresiones de colisión de substrings: "poca potencia" no debe escalar a
    // alto por la keyword "potencia", y "inestable" no debe matchear "estable".
    { text: "tenemos poca potencia disponible", choice: "bajo", confidence: 0.9 },
    { text: "el servicio está inestable", choice: "no_se", confidence: 0.3 },
    { text: "poca potencia, estamos al horno", choice: "bajo", confidence: 0.9 },
  ];

  for (const { text, choice, confidence } of phraseCases) {
    it(`clasifica "${text}" como ${choice} (confianza ${confidence})`, async () => {
      const result = await classifier.classify(text, 3);
      assert.equal(result.choice, choice);
      assert.equal(result.confidence, confidence);
    });
  }

  it("normaliza mayúsculas y tildes", async () => {
    const upper = await classifier.classify("TRÁFICO ALTO", 1);
    assert.equal(upper.choice, "alto");
    const accented = await classifier.classify("está saturado el servicio", 1);
    assert.equal(accented.choice, "alto");
  });

  it("usa otras palabras clave del léxico esperado", async () => {
    assert.equal((await classifier.classify("el pico de tráfico ya pasó", 2)).choice, "alto");
    assert.equal((await classifier.classify("carga estable esta tarde", 2)).choice, "normal");
    assert.equal((await classifier.classify("casi sin tráfico ahora", 2)).choice, "bajo");
  });

  it("devuelve probabilidades plausibles: pico = confianza y suma ≈ 1", async () => {
    for (const { text, choice, confidence } of phraseCases) {
      const result = await classifier.classify(text, 3);
      const total = Object.values(result.probabilities).reduce((a, b) => a + b, 0);
      assert.ok(
        Math.abs(total - 1) < 1e-9,
        `las probabilidades de "${text}" deben sumar ≈ 1, fueron ${total}`,
      );
      assert.equal(result.probabilities[choice], confidence);
    }
  });

  it("ignora las réplicas actuales: la heurística es determinista", async () => {
    const withReplicas = await classifier.classify("tráfico normal", 6);
    const withoutReplicas = await classifier.classify("tráfico normal", 0);
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

  it("devuelve un JevClassifier cuando jevMock es false y hay clave de API", () => {
    process.env.TYPESAFE_API_KEY = "clave-de-prueba";
    const classifier = createClassifier({ jevMock: false });
    assert.ok(classifier instanceof JevClassifier);
    assert.ok(typeof classifier.classify === "function");
  });

  it("lanza el error en español de requireTypesafeApiKey cuando jevMock es false y falta la clave", () => {
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => createClassifier({ jevMock: false }), /TYPESAFE_API_KEY/);
  });
});
