/**
 * Clasificador mock determinista para demos y tests sin red.
 *
 * Sustituye a Jev con una heurística de palabras clave: minúsculas y sin
 * tildes, con orden de evaluación fijo (alto → normal → bajo → no_se) para
 * que la misma frase produzca siempre la misma clasificación.
 */

import type { Classifier, JevClassification, TraficoChoice } from "./jev.js";

/** Distribuciones plausibles por elección: pico = confianza, suma ≈ 1. */
const DISTRIBUTIONS: Record<
  TraficoChoice,
  { confidence: number; probabilities: Record<TraficoChoice, number> }
> = {
  alto: { confidence: 0.92, probabilities: { alto: 0.92, normal: 0.05, bajo: 0.02, no_se: 0.01 } },
  normal: { confidence: 0.9, probabilities: { alto: 0.06, normal: 0.9, bajo: 0.03, no_se: 0.01 } },
  bajo: { confidence: 0.9, probabilities: { alto: 0.03, normal: 0.06, bajo: 0.9, no_se: 0.01 } },
  no_se: { confidence: 0.3, probabilities: { alto: 0.2, normal: 0.25, bajo: 0.25, no_se: 0.3 } },
};

/** Palabras clave por nivel, evaluadas en este orden (alto → normal → bajo).
 *  Cada keyword se matchea como INICIO DE PALABRA (left-anchored word
 *  boundary: `\b<keyword>`, con la keyword escapada). El ancla izquierda
 *  mantiene funcionando los prefijos/tallos ("\bsaturad" sigue matcheando
 *  "saturadísimo") pero bloquea colisiones de substrings: "inestable" ya no
 *  matchea "\bestable" (no hay borde de palabra antes de "estable" dentro de
 *  "inestable").
 *  alto cubre descripciones de tráfico ("mucho", "saturad", "pico") y órdenes
 *  crudas de emergencia tipo película ("todo lo que", "propulsor", "toda la
 *  potencia", "potencia maxima", "maximo"). OJO: NUNCA agregar la palabra
 *  "potencia" sola a alto (robaría "poca potencia disponible" → debe ser
 *  bajo) ni la palabra "todo" sola (robaría "ya está todo normal", que cae en
 *  normal por "normal"). */
const KEYWORDS: ReadonlyArray<{ choice: Exclude<TraficoChoice, "no_se">; words: readonly string[] }> = [
  { choice: "alto", words: ["mucho", "alto", "saturad", "pico", "todo lo que", "propulsor", "toda la potencia", "potencia maxima", "maximo"] },
  { choice: "normal", words: ["normal", "habitual", "estable", "tranqui", "ya esta"] },
  // "poc" (\b-anchored) cubre poco/poca/pocos/pocas.
  { choice: "bajo", words: ["poc", "bajo", "nada", "sin"] },
];

/** Minúsculas y sin tildes (NFD + eliminación de diacríticos combinantes). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Matchea `word` como inicio de palabra en `text` (`\b` + keyword escapada).
 *  La keyword ya viene normalizada (minúsculas, sin tildes), así que el regex
 *  solo necesita escapar caracteres especiales de regex. */
function matchesAtWordBoundary(text: string, word: string): boolean {
  return new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(text);
}

/** Clasificador offline determinista: heurística de palabras clave. */
export class MockClassifier implements Classifier {
  async classify(text: string, _currentReplicas: number): Promise<JevClassification> {
    const normalized = normalize(text);
    let choice: TraficoChoice = "no_se";
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
