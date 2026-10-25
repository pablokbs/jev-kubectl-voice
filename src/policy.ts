/**
 * Política de decisión pura: convierte una clasificación de tráfico en la
 * acción a ejecutar (escalar a N réplicas u omitir el ajuste).
 *
 * No conoce Kubernetes ni el clasificador: es una función pura y trivial de
 * testear de forma tabular.
 */

import type { JevClassification, TraficoChoice } from "./jev.js";
import type { TrafficLevel } from "./config.js";

/** Acción resultante de la política. */
export type PolicyAction =
  | { type: "scale"; replicas: number }
  | { type: "skip"; reason: string };

/** Mapa de réplicas objetivo por nivel de tráfico (bajo/normal/alto). */
export type ReplicasMap = Readonly<Record<TrafficLevel, number>>;

/**
 * Decide la acción a partir de la clasificación.
 *
 * - `no_se`: se omite (el operador no está seguro).
 * - Confianza por debajo del umbral: se omite (comparación estricta `<`; en
 *   el límite exacto, confianza == umbral, se escala).
 * - En otro caso: escalar a `replicasMap[choice]`.
 */
export function decideAction(
  classification: JevClassification,
  replicasMap: ReplicasMap,
  threshold: number,
): PolicyAction {
  if (classification.choice === "no_se") {
    return {
      type: "skip",
      reason:
        "El operador no está seguro del nivel de tráfico (no_se); no se ajustan las réplicas.",
    };
  }

  const choice: Exclude<TraficoChoice, "no_se"> = classification.choice;
  if (classification.confidence < threshold) {
    return {
      type: "skip",
      reason:
        `Confianza ${classification.confidence.toFixed(2)} por debajo del umbral ` +
        `${threshold.toFixed(2)} para "${choice}"; no se ajustan las réplicas.`,
    };
  }

  return { type: "scale", replicas: replicasMap[choice] };
}
