/**
 * Tests de la configuración de cluster externo en `src/config.ts`.
 *
 * El módulo lee el entorno al importarse, así que cada escenario fija sus
 * variables y reimporta el módulo con una query única (cache-busting de ESM)
 * para obtener un `config` recién construido.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Variables relevantes para estos tests (se limpian entre escenarios). */
const CLUSTER_ENV_KEYS = ["K8S_KUBECONFIG", "K8S_CONTEXT"] as const;

/** Fija el entorno dado, limpia el resto de variables del bloque y reimporta `config.ts` fresco. */
async function loadConfig(env: Partial<Record<(typeof CLUSTER_ENV_KEYS)[number], string>>) {
  for (const key of CLUSTER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const query = `?caso=${Math.random().toString(36).slice(2)}`;
  return import(`./config.js${query}`);
}

describe("config: cluster externo (K8S_KUBECONFIG / K8S_CONTEXT)", () => {
  it("deja k8sKubeconfig y k8sContext indefinidos cuando no hay entorno", async () => {
    const { config } = await loadConfig({});
    assert.equal(config.k8sKubeconfig, undefined);
    assert.equal(config.k8sContext, undefined);
  });

  it("parsea K8S_KUBECONFIG y K8S_CONTEXT recortando espacios", async () => {
    const { config } = await loadConfig({
      K8S_KUBECONFIG: "  ./externo.kubeconfig\t",
      K8S_CONTEXT: " prod ",
    });
    assert.equal(config.k8sKubeconfig, "./externo.kubeconfig");
    assert.equal(config.k8sContext, "prod");
  });

  it("trata la cadena vacía o de espacios como sin configurar", async () => {
    const { config } = await loadConfig({ K8S_KUBECONFIG: "   ", K8S_CONTEXT: "" });
    assert.equal(config.k8sKubeconfig, undefined);
    assert.equal(config.k8sContext, undefined);
  });
});
