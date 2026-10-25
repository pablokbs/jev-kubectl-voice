/**
 * Configuración centralizada y tipada del proyecto.
 *
 * Lee variables de entorno en tiempo de importación con valores por defecto,
 * excepto TYPESAFE_API_KEY: esa solo se exige (con un error claro en español)
 * cuando se usa el clasificador Jev real, nunca al importar este módulo,
 * de modo que el modo mock funcione sin ninguna clave.
 */

/** Nivel de tráfico reconocido por el clasificador. */
export type TrafficLevel = "bajo" | "normal" | "alto";

/** Réplicas objetivo por nivel de tráfico (constante tipada).
 *  alto = 10: "pone todo lo que tenemos" lleva el despliegue al tope de la demo. */
export const trafficReplicas = {
  bajo: 1,
  normal: 3,
  alto: 10,
} as const satisfies Record<TrafficLevel, number>;

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(
      `La variable de entorno ${name} debe ser un número entero (valor recibido: "${raw}")`,
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
      `La variable de entorno ${name} debe ser un número (valor recibido: "${raw}")`,
    );
  }
  return value;
}

/** Configuración de la aplicación. */
export const config = {
  /** Puerto del servidor HTTP (PORT, por defecto 3000). */
  port: readInt("PORT", 3000),

  /** Umbral de confianza de la clasificación (CONFIDENCE_THRESHOLD, por defecto 0.5). */
  confidenceThreshold: readFloat("CONFIDENCE_THRESHOLD", 0.5),

  /** Despliegue de Kubernetes a escalar (K8S_DEPLOYMENT, por defecto "nginx-voice"). */
  k8sDeployment: process.env.K8S_DEPLOYMENT?.trim() || "nginx-voice",

  /** Namespace de Kubernetes (K8S_NAMESPACE, por defecto "default"). */
  k8sNamespace: process.env.K8S_NAMESPACE?.trim() || "default",

  /** Selector de pods para contar estados (K8S_POD_SELECTOR, por defecto "app=nginx-voice",
   *  es decir "app=" + el nombre por defecto del despliegue). */
  k8sPodSelector: process.env.K8S_POD_SELECTOR?.trim() || "app=nginx-voice",

  /** Ruta opcional a un archivo kubeconfig de un cluster externo
   *  (K8S_KUBECONFIG). Vacío o con solo espacios = sin configurar: kubectl usa
   *  su kubeconfig por defecto (~/.kube/config y su variable KUBECONFIG). */
  k8sKubeconfig: process.env.K8S_KUBECONFIG?.trim() || undefined,

  /** Nombre de contexto opcional dentro del kubeconfig (K8S_CONTEXT).
   *  Vacío o con solo espacios = sin configurar: kubectl usa el contexto
   *  actual del kubeconfig que aplique. */
  k8sContext: process.env.K8S_CONTEXT?.trim() || undefined,

  /** Réplicas objetivo por nivel de tráfico. */
  trafficReplicas,

  /** true si JEV_MOCK=1: clasificador offline determinista, sin clave de API. */
  jevMock: process.env.JEV_MOCK === "1",
};

/**
 * Devuelve la clave de API de TypeSafe AI.
 *
 * Solo debe llamarse en el camino del clasificador Jev REAL. En modo mock
 * (JEV_MOCK=1) no se invoca, así que la aplicación arranca sin clave.
 * Lanza un error claro en español si falta la clave.
 */
export function requireTypesafeApiKey(): string {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Falta TYPESAFE_API_KEY: es obligatoria para usar el clasificador Jev real. " +
        "Crea una clave en el dashboard de TypeSafe AI, colócala en tu archivo .env " +
        "(no lo commitees) o establece JEV_MOCK=1 para usar el clasificador offline determinista.",
    );
  }
  return key;
}
