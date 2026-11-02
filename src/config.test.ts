/**
 * Tests of the external cluster configuration in `src/config.ts`.
 *
 * The module reads the environment at import time, so each scenario sets its
 * variables and re-imports the module with a unique query (ESM cache-busting)
 * to get a freshly built `config`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Relevant variables for these tests (cleared between scenarios). */
const CLUSTER_ENV_KEYS = ["K8S_KUBECONFIG", "K8S_CONTEXT"] as const;

/** Sets the given environment, clears the rest of the block's keys and re-imports `config.ts` fresh. */
async function loadConfig(env: Partial<Record<(typeof CLUSTER_ENV_KEYS)[number], string>>) {
  for (const key of CLUSTER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  const query = `?case=${Math.random().toString(36).slice(2)}`;
  return import(`./config.js${query}`);
}

describe("config: external cluster (K8S_KUBECONFIG / K8S_CONTEXT)", () => {
  it("leaves k8sKubeconfig and k8sContext undefined when there is no environment", async () => {
    const { config } = await loadConfig({});
    assert.equal(config.k8sKubeconfig, undefined);
    assert.equal(config.k8sContext, undefined);
  });

  it("parses K8S_KUBECONFIG and K8S_CONTEXT trimming whitespace", async () => {
    const { config } = await loadConfig({
      K8S_KUBECONFIG: "  ./external.kubeconfig\t",
      K8S_CONTEXT: " prod ",
    });
    assert.equal(config.k8sKubeconfig, "./external.kubeconfig");
    assert.equal(config.k8sContext, "prod");
  });

  it("treats an empty or whitespace-only string as unset", async () => {
    const { config } = await loadConfig({ K8S_KUBECONFIG: "   ", K8S_CONTEXT: "" });
    assert.equal(config.k8sKubeconfig, undefined);
    assert.equal(config.k8sContext, undefined);
  });
});