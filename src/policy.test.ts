/**
 * Tests de la política de decisión pura (`decideAction`).
 *
 * Tabla de casos: mapeo de niveles a réplicas, omisión por `no_se`, omisión
 * por confianza baja y el caso límite confianza == umbral.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideAction } from "./policy.js";
import type { JevClassification } from "./jev.js";
import type { TrafficLevel } from "./config.js";

const THRESHOLD = 0.5;
const REPLICAS: Readonly<Record<TrafficLevel, number>> = {
  bajo: 1,
  normal: 3,
  alto: 10,
};

function classificationOf(choice: JevClassification["choice"], confidence: number): JevClassification {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

describe("decideAction", () => {
  // Tabla: cada nivel con confianza por encima del umbral escala al mapa dado.
  const scaleCases: ReadonlyArray<{
    choice: Exclude<JevClassification["choice"], "no_se">;
    confidence: number;
    replicas: number;
  }> = [
    { choice: "bajo", confidence: 0.99, replicas: 1 },
    { choice: "normal", confidence: 0.8, replicas: 3 },
    { choice: "alto", confidence: 0.6, replicas: 10 },
  ];

  for (const { choice, confidence, replicas } of scaleCases) {
    it(`escala "${choice}" a ${replicas} réplicas con confianza ${confidence} >= umbral ${THRESHOLD}`, () => {
      const action = decideAction(
        classificationOf(choice, confidence),
        REPLICAS,
        THRESHOLD,
      );
      assert.deepStrictEqual(action, { type: "scale", replicas });
    });
  }

  it("usa el mapa de réplicas recibido, no una constante interna", () => {
    const customMap = { bajo: 2, normal: 4, alto: 8 };
    const action = decideAction(classificationOf("normal", 0.9), customMap, THRESHOLD);
    assert.deepStrictEqual(action, { type: "scale", replicas: 4 });
  });

  it("omite el ajuste cuando la elección es no_se, aunque la confianza sea alta", () => {
    const action = decideAction(classificationOf("no_se", 0.99), REPLICAS, THRESHOLD);
    assert.equal(action.type, "skip");
    assert.ok(
      action.type === "skip" && /no_se/i.test(action.reason),
      `la razón debe mencionar no_se, recibió: ${action.type === "skip" ? action.reason : "acción de escalado"}`,
    );
  });

  it("omite el ajuste cuando la confianza 0.49 es menor que el umbral 0.5", () => {
    const action = decideAction(classificationOf("alto", 0.49), REPLICAS, THRESHOLD);
    assert.equal(action.type, "skip");
    assert.ok(action.type === "skip" && action.reason.includes("0.49"), "la razón debe incluir la confianza 0.49");
    assert.ok(action.type === "skip" && action.reason.includes("0.50"), "la razón debe incluir el umbral 0.50");
  });

  it("escala en el límite exacto: confianza == umbral (comparación >=)", () => {
    const action = decideAction(classificationOf("alto", 0.5), REPLICAS, 0.5);
    assert.deepStrictEqual(action, { type: "scale", replicas: 10 });
  });

  it("omite con confianza por debajo del umbral para cualquier nivel", () => {
    for (const choice of ["bajo", "normal", "alto"] as const) {
      const action = decideAction(classificationOf(choice, 0.1), REPLICAS, 0.5);
      assert.equal(action.type, "skip", `nivel ${choice} debería omitirse con confianza 0.1`);
    }
  });
});
