/**
 * Centralized, typed configuration for the project.
 *
 * Reads environment variables at import time with defaults, except for
 * TYPESAFE_API_KEY: it is only required (with a clear error message) when the
 * real Jev classifier is used, never when importing this module, so mock mode
 * works without any key.
 */

/** Traffic level recognized by the classifier. */
export type TrafficLevel = "low" | "normal" | "high";

/** Target replicas per traffic level (typed constant).
 *  high = 10: "put everything we have" takes the deployment to the demo's ceiling. */
export const trafficReplicas = {
  low: 1,
  normal: 3,
  high: 10,
} as const satisfies Record<TrafficLevel, number>;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(
      `Environment variable ${name} must be an integer (received: "${raw}")`,
    );
  }
  return value;
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(
      `Environment variable ${name} must be a number (received: "${raw}")`,
    );
  }
  return value;
}

/** Application configuration. */
export const config = {
  /** HTTP server port (PORT, default 3000). */
  port: readInt("PORT", 3000),

  /** Classification confidence threshold (CONFIDENCE_THRESHOLD, default 0.5). */
  confidenceThreshold: readFloat("CONFIDENCE_THRESHOLD", 0.5),

  /** Kubernetes deployment to scale (K8S_DEPLOYMENT, default "nginx-voice"). */
  k8sDeployment: process.env.K8S_DEPLOYMENT?.trim() || "nginx-voice",

  /** Kubernetes namespace (K8S_NAMESPACE, default "default"). */
  k8sNamespace: process.env.K8S_NAMESPACE?.trim() || "default",

  /** Pod selector used to count states (K8S_POD_SELECTOR, default "app=nginx-voice",
   *  i.e. "app=" + the default deployment name). */
  k8sPodSelector: process.env.K8S_POD_SELECTOR?.trim() || "app=nginx-voice",

  /** Optional path to a kubeconfig file for an external cluster
   *  (K8S_KUBECONFIG). Empty or whitespace-only = unset: kubectl uses its
   *  default kubeconfig (~/.kube/config and its KUBECONFIG variable). */
  k8sKubeconfig: process.env.K8S_KUBECONFIG?.trim() || undefined,

  /** Optional context name inside the kubeconfig (K8S_CONTEXT).
   *  Empty or whitespace-only = unset: kubectl uses the current context of
   *  whichever kubeconfig applies. */
  k8sContext: process.env.K8S_CONTEXT?.trim() || undefined,

  /** Target replicas per traffic level. */
  trafficReplicas,

  /** true if JEV_MOCK=1: deterministic offline classifier, no API key. */
  jevMock: process.env.JEV_MOCK === "1",
};

/**
 * Returns the TypeSafe AI API key.
 *
 * Only call this on the REAL Jev classifier path. In mock mode (JEV_MOCK=1)
 * it is never invoked, so the app starts without a key.
 * Throws a clear error if the key is missing.
 */
export function requireTypesafeApiKey(): string {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TYPESAFE_API_KEY is missing: it is required to use the real Jev classifier. " +
        "Create a key in the TypeSafe AI dashboard, put it in your .env file " +
        "(do not commit it), or set JEV_MOCK=1 to use the deterministic offline classifier.",
    );
  }
  return key;
}