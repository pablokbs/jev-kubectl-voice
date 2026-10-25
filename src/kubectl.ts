/**
 * Envoltorio tipado sobre `kubectl` para consultar y escalar el despliegue.
 *
 * Nunca construye una cadena de shell: el runner por defecto usa `execFile`
 * con el binario `kubectl` y un array de argumentos, de modo que ningún texto
 * (nombre del despliegue, namespace) pueda interpretarse como parte del
 * comando. La ejecución es inyectable (`KubectlRunner`) para testear sin
 * kubectl ni clúster.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Estado de un despliegue, limitado a lo que la demo necesita. */
export interface DeploymentStatus {
  /** Réplicas deseadas (`spec.replicas`). */
  replicas: number;
  /** Réplicas listas (`status.readyReplicas`). */
  readyReplicas: number;
}

/** Desglose de estados de los pods seleccionados, lo que pinta la UI. */
export interface PodStates {
  /** Pods con phase Running y todos los contenedores ready. */
  running: number;
  /** Pods arrancando (Pending, CrashLoop, Running con contenedores no listos…). */
  starting: number;
  /** Pods con metadata.deletionTimestamp (terminando). */
  terminating: number;
}

/** Tipos de fallo reconocidos por el envoltorio de kubectl. */
export type KubectlErrorKind = "not_found" | "kubectl_unavailable" | "kubectl_failed";

/** Opciones adicionales de `KubectlError`. */
export interface KubectlErrorOptions {
  /** stderr crudo capturado de kubectl, si existe. */
  stderr?: string;
  /** Código de salida del proceso, si kubectl llegó a ejecutarse. */
  exitCode?: number;
  /** Error original (de execFile o de JSON.parse). */
  cause?: unknown;
}

/** Error tipado para cualquier fallo de kubectl, discriminado por `kind`. */
export class KubectlError extends Error {
  /** Discriminador del tipo de fallo. */
  readonly kind: KubectlErrorKind;
  /** stderr crudo capturado, si lo hubo. */
  readonly stderr: string | undefined;
  /** Código de salida del proceso, si kubectl llegó a ejecutarse. */
  readonly exitCode: number | undefined;

  constructor(
    kind: KubectlErrorKind,
    message: string,
    options: KubectlErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "KubectlError";
    this.kind = kind;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}

/**
 * Costura de inyección: ejecuta kubectl con el array de argumentos dado y
 * devuelve stdout/stderr. Cualquier implementación debe lanzar el proceso sin
 * shell y rechazar con el error crudo de ejecución.
 */
export type KubectlRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/**
 * Runner por defecto: `execFile("kubectl", args)`. Sin shell y sin
 * interpolación de texto: el nombre y el namespace viajan como argumentos
 * separados, nunca como parte de una cadena de comando.
 */
export const defaultKubectlRunner: KubectlRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync("kubectl", args);
  return { stdout, stderr };
};

/** Forma del error que rechaza `execFile` promisificado (o de un doble de prueba). */
interface ExecFailure {
  code?: string | number;
  stderr?: string | Buffer;
}

function stderrOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Mapea un fallo crudo de ejecución de kubectl al `KubectlError` correspondiente:
 *
 * - `ENOENT` → `kubectl_unavailable` (el binario no está instalado o no está
 *   en el PATH).
 * - Salida no cero con `NotFound` en stderr → `not_found`.
 * - Cualquier otro caso → `kubectl_failed`, conservando stderr y código de salida.
 */
export function toKubectlError(error: unknown): KubectlError {
  const failure = (error ?? {}) as ExecFailure;
  const stderr = stderrOf(failure.stderr);

  if (failure.code === "ENOENT") {
    return new KubectlError(
      "kubectl_unavailable",
      "El binario kubectl no está disponible (ENOENT): instálalo y verifica que esté en el PATH.",
      { stderr, cause: error },
    );
  }

  const exitCode = typeof failure.code === "number" ? failure.code : undefined;
  if (exitCode !== undefined && stderr.includes("NotFound")) {
    return new KubectlError(
      "not_found",
      `kubectl no encontró el recurso (código de salida ${exitCode}).`,
      { stderr, exitCode, cause: error },
    );
  }

  return new KubectlError(
    "kubectl_failed",
    `kubectl falló (código de salida ${failure.code ?? "desconocido"}).`,
    { stderr, exitCode, cause: error },
  );
}

/** Selección explícita de cluster para kubectl: flags globales opcionales. */
export interface KubectlCluster {
  /** Ruta a un archivo kubeconfig alternativo (viaja como `--kubeconfig <ruta>`). */
  kubeconfig?: string;
  /** Nombre de contexto dentro del kubeconfig (viaja como `--context <nombre>`). */
  context?: string;
}

/**
 * Construye los argumentos globales de selección de cluster, siempre como
 * elementos separados del array (nunca dentro de una cadena de comando):
 * kubeconfig → `--kubeconfig <ruta>`, contexto → `--context <nombre>`, en ese
 * orden determinista. Sin ninguno devuelve `[]`, de modo que kubectl use su
 * comportamiento por defecto (kubeconfig y contexto actuales).
 */
function clusterArgs(cluster: KubectlCluster | undefined): string[] {
  if (!cluster) return [];
  const args: string[] = [];
  if (cluster.kubeconfig) args.push("--kubeconfig", cluster.kubeconfig);
  if (cluster.context) args.push("--context", cluster.context);
  return args;
}

/** Ejecuta el runner inyectado y mapea cualquier rechazo crudo a `KubectlError`. */
async function runKubectl(
  args: string[],
  runner: KubectlRunner,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runner(args);
  } catch (error) {
    if (error instanceof KubectlError) throw error;
    throw toKubectlError(error);
  }
}

/**
 * Consulta el estado de un despliegue:
 * `kubectl get deployment <name> -n <ns> -o json [--kubeconfig <ruta>] [--context <nombre>]`.
 *
 * Los flags de cluster (opcionales) se añaden al final: kubectl acepta sus
 * flags globales después de los argumentos del comando.
 *
 * Devuelve `{ replicas, readyReplicas }` con 0 como valor por defecto cuando
 * `spec.replicas` o `status.readyReplicas` faltan en la salida.
 */
export async function getStatus(
  name: string,
  namespace: string,
  runner: KubectlRunner = defaultKubectlRunner,
  cluster?: KubectlCluster,
): Promise<DeploymentStatus> {
  const { stdout } = await runKubectl(
    ["get", "deployment", name, "-n", namespace, "-o", "json", ...clusterArgs(cluster)],
    runner,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (parseError) {
    const snippet = stdout.trim().slice(0, 200);
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    throw new KubectlError(
      "kubectl_failed",
      `No se pudo analizar la salida JSON de kubectl: ${reason}. Salida recibida: "${snippet}"`,
      { cause: parseError },
    );
  }

  const document: object = typeof parsed === "object" && parsed !== null ? parsed : {};
  const spec = (document as { spec?: { replicas?: unknown } }).spec;
  const status = (document as { status?: { readyReplicas?: unknown } }).status;
  return {
    replicas: typeof spec?.replicas === "number" ? spec.replicas : 0,
    readyReplicas: typeof status?.readyReplicas === "number" ? status.readyReplicas : 0,
  };
}

/**
 * Clasifica un pod de la lista JSON en su estado para la demo:
 *
 * - `metadata.deletionTimestamp` presente → `terminating`.
 * - `status.phase === "Running"` con `status.containerStatuses` no vacío y
 *   todos los contenedores `ready: true` → `running`.
 * - Cualquier otro caso (Pending, sin containerStatuses, Running no listo…) → `starting`.
 */
function classifyPod(item: unknown): keyof PodStates {
  const pod = typeof item === "object" && item !== null ? item : {};
  const metadata = (pod as { metadata?: { deletionTimestamp?: unknown } }).metadata;
  if (metadata?.deletionTimestamp) return "terminating";

  const status = (pod as { status?: { phase?: unknown; containerStatuses?: unknown } }).status;
  const containerStatuses = status?.containerStatuses;
  const allReady =
    status?.phase === "Running" &&
    Array.isArray(containerStatuses) &&
    containerStatuses.length > 0 &&
    containerStatuses.every((cs) => (cs as { ready?: unknown } | null)?.ready === true);
  return allReady ? "running" : "starting";
}

/**
 * Consulta el desglose de estados de los pods del selector:
 * `kubectl get pods -l <selector> -n <ns> -o json [--kubeconfig <ruta>] [--context <nombre>]`.
 *
 * Los flags de cluster (opcionales) se añaden al final, igual que en `getStatus`.
 *
 * Items ausentes o vacíos → todo en ceros. Salida no JSON → `KubectlError`
 * con kind `kubectl_failed` (los fallos de ejecución se mapean igual que en
 * `getStatus`, incluida la semántica `not_found` cuando kubectl así responde).
 */
export async function getPodStates(
  podSelector: string,
  namespace: string,
  runner: KubectlRunner = defaultKubectlRunner,
  cluster?: KubectlCluster,
): Promise<PodStates> {
  const { stdout } = await runKubectl(
    ["get", "pods", "-l", podSelector, "-n", namespace, "-o", "json", ...clusterArgs(cluster)],
    runner,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (parseError) {
    const snippet = stdout.trim().slice(0, 200);
    const reason = parseError instanceof Error ? parseError.message : String(parseError);
    throw new KubectlError(
      "kubectl_failed",
      `No se pudo analizar la salida JSON de kubectl (pods): ${reason}. Salida recibida: "${snippet}"`,
      { cause: parseError },
    );
  }

  const document: object = typeof parsed === "object" && parsed !== null ? parsed : {};
  const items = (document as { items?: unknown }).items;
  const states: PodStates = { running: 0, starting: 0, terminating: 0 };
  if (!Array.isArray(items)) return states;
  for (const item of items) {
    states[classifyPod(item)] += 1;
  }
  return states;
}

/**
 * Escala un despliegue:
 * `kubectl scale deployment <name> -n <ns> --replicas=<n> [--kubeconfig <ruta>] [--context <nombre>]`.
 *
 * Los flags de cluster (opcionales) van al final: kubectl acepta los flags
 * globales después de los argumentos del comando.
 *
 * Valida que `replicas` sea un entero seguro >= 0 (rechaza NaN, fracciones y
 * negativos) antes de invocar kubectl. No devuelve nada.
 */
export async function scaleDeployment(
  name: string,
  replicas: number,
  namespace: string,
  runner: KubectlRunner = defaultKubectlRunner,
  cluster?: KubectlCluster,
): Promise<void> {
  if (!Number.isSafeInteger(replicas) || replicas < 0) {
    throw new TypeError(
      `Las réplicas deben ser un entero seguro >= 0 (recibido: ${String(replicas)})`,
    );
  }
  await runKubectl(
    ["scale", "deployment", name, "-n", namespace, `--replicas=${replicas}`, ...clusterArgs(cluster)],
    runner,
  );
}
