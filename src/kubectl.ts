/**
 * Typed wrapper around `kubectl` for querying and scaling the deployment.
 *
 * Never builds a shell string: the default runner uses `execFile` with the
 * `kubectl` binary and an argument array, so no text (deployment name,
 * namespace) can be interpreted as part of the command. The execution is
 * injectable (`KubectlRunner`) for testing without kubectl or a cluster.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Status of a deployment, limited to what the demo needs. */
export interface DeploymentStatus {
  /** Desired replicas (`spec.replicas`). */
  replicas: number;
  /** Ready replicas (`status.readyReplicas`). */
  readyReplicas: number;
}

/** Breakdown of the selected pods' states, what the UI paints. */
export interface PodStates {
  /** Pods with phase Running and all containers ready. */
  running: number;
  /** Pods starting up (Pending, CrashLoop, Running with not-ready containers…). */
  starting: number;
  /** Pods with metadata.deletionTimestamp (terminating). */
  terminating: number;
}

/** Failure kinds recognized by the kubectl wrapper. */
export type KubectlErrorKind = "not_found" | "kubectl_unavailable" | "kubectl_failed";

/** Additional options for `KubectlError`. */
export interface KubectlErrorOptions {
  /** Raw stderr captured from kubectl, if any. */
  stderr?: string;
  /** Exit code of the process, if kubectl actually ran. */
  exitCode?: number;
  /** Original error (from execFile or JSON.parse). */
  cause?: unknown;
}

/** Typed error for any kubectl failure, discriminated by `kind`. */
export class KubectlError extends Error {
  /** Failure-kind discriminator. */
  readonly kind: KubectlErrorKind;
  /** Raw captured stderr, if any. */
  readonly stderr: string | undefined;
  /** Exit code of the process, if kubectl actually ran. */
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
 * Injection seam: runs kubectl with the given argument array and returns
 * stdout/stderr. Any implementation must spawn the process without a shell
 * and reject with the raw execution error.
 */
export type KubectlRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/**
 * Default runner: `execFile("kubectl", args)`. No shell and no text
 * interpolation: the name and namespace travel as separate arguments, never
 * as part of a command string.
 */
export const defaultKubectlRunner: KubectlRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync("kubectl", args);
  return { stdout, stderr };
};

/** Shape of the error that promisified `execFile` rejects with (or a test double). */
interface ExecFailure {
  code?: string | number;
  stderr?: string | Buffer;
}

function stderrOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Maps a raw kubectl execution failure to the corresponding `KubectlError`:
 *
 * - `ENOENT` → `kubectl_unavailable` (binary not installed or not on PATH).
 * - Non-zero exit with `NotFound` in stderr → `not_found`.
 * - Any other case → `kubectl_failed`, preserving stderr and exit code.
 */
export function toKubectlError(error: unknown): KubectlError {
  const failure = (error ?? {}) as ExecFailure;
  const stderr = stderrOf(failure.stderr);

  if (failure.code === "ENOENT") {
    return new KubectlError(
      "kubectl_unavailable",
      "The kubectl binary is not available (ENOENT): install it and verify it is on your PATH.",
      { stderr, cause: error },
    );
  }

  const exitCode = typeof failure.code === "number" ? failure.code : undefined;
  if (exitCode !== undefined && stderr.includes("NotFound")) {
    return new KubectlError(
      "not_found",
      `kubectl did not find the resource (exit code ${exitCode}).`,
      { stderr, exitCode, cause: error },
    );
  }

  return new KubectlError(
    "kubectl_failed",
    `kubectl failed (exit code ${failure.code ?? "unknown"}).`,
    { stderr, exitCode, cause: error },
  );
}

/** Explicit cluster selection for kubectl: optional global flags. */
export interface KubectlCluster {
  /** Path to an alternative kubeconfig file (travels as `--kubeconfig <path>`). */
  kubeconfig?: string;
  /** Context name inside the kubeconfig (travels as `--context <name>`). */
  context?: string;
}

/**
 * Builds the global cluster-selection arguments, always as separate array
 * elements (never inside a command string): kubeconfig → `--kubeconfig <path>`,
 * context → `--context <name>`, in that deterministic order. With neither set
 * it returns `[]`, so kubectl uses its default behaviour (current kubeconfig
 * and context).
 */
function clusterArgs(cluster: KubectlCluster | undefined): string[] {
  if (!cluster) return [];
  const args: string[] = [];
  if (cluster.kubeconfig) args.push("--kubeconfig", cluster.kubeconfig);
  if (cluster.context) args.push("--context", cluster.context);
  return args;
}

/** Runs the injected runner and maps any raw rejection to `KubectlError`. */
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
 * Queries a deployment's status:
 * `kubectl get deployment <name> -n <ns> -o json [--kubeconfig <path>] [--context <name>]`.
 *
 * The (optional) cluster flags are appended at the end: kubectl accepts its
 * global flags after the command arguments.
 *
 * Returns `{ replicas, readyReplicas }` with 0 as the default when
 * `spec.replicas` or `status.readyReplicas` are missing from the output.
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
      `Could not parse kubectl's JSON output: ${reason}. Received: "${snippet}"`,
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
 * Classifies a pod from the JSON list into its demo state:
 *
 * - `metadata.deletionTimestamp` present → `terminating`.
 * - `status.phase === "Running"` with non-empty `status.containerStatuses`
 *   and all containers `ready: true` → `running`.
 * - Any other case (Pending, no containerStatuses, Running not ready…) → `starting`.
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
 * Queries the state breakdown of the selector's pods:
 * `kubectl get pods -l <selector> -n <ns> -o json [--kubeconfig <path>] [--context <name>]`.
 *
 * The (optional) cluster flags are appended at the end, same as in `getStatus`.
 *
 * Missing or empty items → all zeros. Non-JSON output → `KubectlError` with
 * kind `kubectl_failed` (execution failures map the same as in `getStatus`,
 * including the `not_found` semantics when kubectl answers that way).
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
      `Could not parse kubectl's JSON output (pods): ${reason}. Received: "${snippet}"`,
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
 * Scales a deployment:
 * `kubectl scale deployment <name> -n <ns> --replicas=<n> [--kubeconfig <path>] [--context <name>]`.
 *
 * The (optional) cluster flags go at the end: kubectl accepts global flags
 * after the command arguments.
 *
 * Validates that `replicas` is a safe integer >= 0 (rejects NaN, fractions
 * and negatives) before invoking kubectl. Returns nothing.
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
      `Replicas must be a safe integer >= 0 (received: ${String(replicas)})`,
    );
  }
  await runKubectl(
    ["scale", "deployment", name, "-n", namespace, `--replicas=${replicas}`, ...clusterArgs(cluster)],
    runner,
  );
}