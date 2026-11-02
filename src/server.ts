/**
 * HTTP server for the demo (no frameworks, plain `node:http`).
 *
 * Routes:
 * - `GET /` and static files under `public/`: the demo frontend. If
 *   `public/index.html` does not exist yet, an English placeholder page is
 *   served (the frontend arrives in phase 2). Nothing outside `public/` is
 *   ever served (safe path join with prefix check) and only known content
 *   types are allowed (.html/.css/.js/.svg/.png); anything else → JSON 404.
 * - `POST /api/voice-command`: receives `{"text": "..."}`, queries the
 *   deployment's current state, classifies with Jev, decides with the policy
 *   and scales with kubectl. Demo resilience rule: neither kubectl nor Jev
 *   cause a 500 — a classification failure degrades to `502` with `{error}`
 *   and a kubectl failure mid-flow degrades to `200` with
 *   `action.type: "error"` and the classification intact. The `200`
 *   response includes `timings` (`classify_ms` and `total_ms`, integer ms)
 *   to show on screen how long Jev took to decide.
 * - `GET /api/status`: the deployment's current state plus the pod state
 *   breakdown (`pods: {running, starting, terminating}`), or `503` with
 *   `replicas: null`, zeroed pods and an error message if kubectl fails.
 *
 * The server does not listen on import: `createVoiceServer` returns an
 * `http.Server` (injectable for tests) and only the direct-run guard calls
 * `listen` with `config.port`, logging the Jev mode (mock/real).
 */

import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

import { config } from "./config.js";
import type { TrafficLevel } from "./config.js";
import { createClassifier } from "./jev.js";
import type { Classifier, JevClassification } from "./jev.js";
import { decideAction } from "./policy.js";
import { defaultKubectlRunner, getPodStates, getStatus, scaleDeployment } from "./kubectl.js";
import type { KubectlRunner, PodStates } from "./kubectl.js";

/**
 * Injectable dependency that queries the pod state breakdown
 * (`getPodStates` over the default runner, or a double in tests).
 */
export type PodStatesReader = (
  podSelector: string,
  namespace: string,
) => Promise<PodStates>;

/** Configuration the server needs (structurally compatible with `config`). */
export interface ServerConfig {
  /** Listen port on direct startup. */
  port: number;
  /** Confidence threshold of the scaling policy. */
  confidenceThreshold: number;
  /** Kubernetes deployment name. */
  k8sDeployment: string;
  /** Kubernetes namespace. */
  k8sNamespace: string;
  /** Pod selector for the state breakdown (GET /api/status). */
  k8sPodSelector: string;
  /** Optional path to a kubeconfig for an external cluster (K8S_KUBECONFIG);
   *  absent/empty = kubectl uses its default kubeconfig. */
  k8sKubeconfig?: string;
  /** Optional context inside the kubeconfig (K8S_CONTEXT); absent/empty =
   *  kubectl uses the current context. */
  k8sContext?: string;
  /** Target replicas per traffic level. */
  trafficReplicas: Readonly<Record<TrafficLevel, number>>;
  /** true if Jev runs in mock mode (deterministic, no network). */
  jevMock: boolean;
}

/** Server factory options: everything injectable for tests. */
export interface ServerOptions {
  /** Configuration; default is the project's central `config`. */
  cfg?: ServerConfig;
  /** Classifier; default `createClassifier(cfg)` (mock or real). */
  classifier?: Classifier;
  /** kubectl runner; default `execFile("kubectl", ...)` without a shell. */
  kubectlRunner?: KubectlRunner;
  /**
   * Pod state breakdown reader for `/api/status`; default
   * `getPodStates(k8sPodSelector, k8sNamespace)` over the kubectl runner.
   */
  podStatesReader?: PodStatesReader;
  /** Static files directory; default `public/` next to the repo root. */
  publicDir?: string;
  /** Delay after `kubectl scale` before re-reading the state (ms). */
  settleDelayMs?: number;
}

/** `action` part of the `/api/voice-command` response. */
export interface VoiceCommandAction {
  type: "scaled" | "skipped" | "error";
  replicas_before: number | null;
  replicas_after: number | null;
  reason?: string;
}

/** `timings` part of the `200` response of `/api/voice-command` (integer ms). */
export interface VoiceCommandTimings {
  /** Milliseconds Jev took to classify the transcript. */
  classify_ms: number;
  /** Milliseconds of the whole flow, from handler start to response. */
  total_ms: number;
}

/** Complete shape of the `200` response of `/api/voice-command`. */
export interface VoiceCommandResponse {
  transcript: string;
  classification: {
    choice: JevClassification["choice"];
    probabilities: Record<string, number>;
    confidence: number;
  };
  action: VoiceCommandAction;
  /** Demo timings: the frontend shows `classify_ms` next to the confidence. */
  timings: VoiceCommandTimings;
}

/** Body limit for `POST /api/voice-command` (~10 KB). */
const MAX_BODY_BYTES = 10 * 1024;

/** Zeroed pod breakdown: the constant body shape on failure. */
const ZERO_POD_STATES: PodStates = { running: 0, starting: 0, terminating: 0 };

/** Absolute drain cap before cutting off an oversized body. */
const HARD_DRAIN_CAP_BYTES = 1024 * 1024;

/** Default delay after scaling, to give kubectl breathing room in the demo. */
const DEFAULT_SETTLE_DELAY_MS = 500;

/** Content types served from `public/`; any other extension → 404. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Placeholder page while the frontend (phase 2) does not exist yet. */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo: voice commands with Jev and kubectl</title>
  </head>
  <body>
    <h1>Demo: voice commands with Jev and kubectl</h1>
    <p>The frontend arrives in phase 2. The backend already responds:</p>
    <ul>
      <li><code>POST /api/voice-command</code> with <code>{"text": "&lt;transcript&gt;"}</code></li>
      <li><code>GET /api/status</code></li>
    </ul>
  </body>
</html>
`;

/** Single message for any unrecognized route/method. */
const UNKNOWN_ROUTE_ERROR = { error: "Route not found." };

/** Safely extracts the message of an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Is this the classic "file does not exist" error? */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Passive wait of `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sends a body with the given status and content type (content-length included). */
function sendBytes(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  if (res.destroyed) return;
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { "content-type": contentType, "content-length": payload.length });
  res.end(payload);
}

/** Sends JSON with utf-8 charset. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendBytes(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

/**
 * Reads the request body with a size limit.
 *
 * If the body exceeds `MAX_BODY_BYTES`, it is marked as too large but still
 * drained (up to `HARD_DRAIN_CAP_BYTES`) before responding, so the client
 * receives the `413` instead of a connection reset.
 */
function readBody(req: IncomingMessage): Promise<{ ok: boolean; body: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ ok: !tooLarge, body: Buffer.concat(chunks).toString("utf8") });
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      if (size > HARD_DRAIN_CAP_BYTES) {
        req.destroy();
        finish();
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", finish);
    req.on("error", () => {
      tooLarge = true;
      finish();
    });
  });
}

/**
 * Creates the HTTP server with all dependencies injectable.
 *
 * It does not listen: the caller decides the port (`server.listen`). The
 * direct startup at the end of this module is the only one using `config.port`.
 */
export function createVoiceServer(options: ServerOptions = {}): http.Server {
  const cfg: ServerConfig = options.cfg ?? config;
  const classifier = options.classifier ?? createClassifier(cfg);
  const kubectlRunner = options.kubectlRunner ?? defaultKubectlRunner;
  const podStatesReader: PodStatesReader =
    options.podStatesReader ??
    ((podSelector, namespace) => getPodStates(podSelector, namespace, kubectlRunner, cluster));
  const publicDir = path.resolve(
    options.publicDir ?? fileURLToPath(new URL("../public", import.meta.url)),
  );
  const settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;

  /** External cluster selection (kubeconfig/context) for each kubectl call. */
  const cluster = { kubeconfig: cfg.k8sKubeconfig, context: cfg.k8sContext };

  /**
   * Result of the voice flow: `200` with the full response, or `502` with
   * `{error}` when the classifier fails (never a 500 because of Jev/kubectl).
   */
  type FlowResult =
    | { status: 200; body: Omit<VoiceCommandResponse, "timings">; classifyMs: number }
    | { status: 502; body: { error: string } };

  /** Queries the current state; on failure returns null (demo resilience). */
  async function statusOrReplicasBefore(): Promise<number | null> {
    try {
      const status = await getStatus(cfg.k8sDeployment, cfg.k8sNamespace, kubectlRunner, cluster);
      return status.replicas;
    } catch {
      return null;
    }
  }

  /** Full flow: previous state → classify → decide → scale → confirm. */
  async function runVoiceFlow(text: string): Promise<FlowResult> {
    const replicasBefore = await statusOrReplicasBefore();
    // Without a previous state (kubectl missing or failing) the classifier gets 0.
    const currentReplicas = replicasBefore ?? 0;

    const classifyStart = performance.now();
    let classification: JevClassification;
    try {
      classification = await classifier.classify(text, currentReplicas);
    } catch (error) {
      return {
        status: 502,
        body: {
          error:
            `Could not classify the transcript with Jev: ${messageOf(error)}. ` +
            "No replicas were adjusted.",
        },
      };
    }
    const classifyMs = Math.round(performance.now() - classifyStart);

    const classificationPayload = {
      choice: classification.choice,
      probabilities: classification.probabilities,
      confidence: classification.confidence,
    };

    const decision = decideAction(classification, cfg.trafficReplicas, cfg.confidenceThreshold);

    if (decision.type === "skip") {
      return {
        status: 200,
        body: {
          transcript: text,
          classification: classificationPayload,
          action: {
            type: "skipped",
            replicas_before: replicasBefore,
            replicas_after: null,
            reason: decision.reason,
          },
        },
        classifyMs,
      };
    }

    try {
      await scaleDeployment(cfg.k8sDeployment, decision.replicas, cfg.k8sNamespace, kubectlRunner, cluster);
    } catch (error) {
      return {
        status: 200,
        body: {
          transcript: text,
          classification: classificationPayload,
          action: {
            type: "error",
            replicas_before: replicasBefore,
            replicas_after: null,
            reason:
              `Could not scale deployment "${cfg.k8sDeployment}" to ${decision.replicas} replicas: ` +
              `${messageOf(error)}.`,
          },
        },
        classifyMs,
      };
    }

    await sleep(settleDelayMs);

    try {
      const status = await getStatus(cfg.k8sDeployment, cfg.k8sNamespace, kubectlRunner, cluster);
      return {
        status: 200,
        body: {
          transcript: text,
          classification: classificationPayload,
          action: {
            type: "scaled",
            replicas_before: replicasBefore,
            replicas_after: status.replicas,
          },
        },
        classifyMs,
      };
    } catch (error) {
      return {
        status: 200,
        body: {
          transcript: text,
          classification: classificationPayload,
          action: {
            type: "error",
            replicas_before: replicasBefore,
            replicas_after: null,
            reason:
              `The scale to ${decision.replicas} replicas was sent, but the deployment status ` +
              `could not be confirmed: ${messageOf(error)}.`,
          },
        },
        classifyMs,
      };
    }
  }

  /** POST /api/voice-command: validates the body and runs the voice flow. */
  async function handleVoiceCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const flowStart = performance.now();
    const { ok, body } = await readBody(req);
    if (!ok) {
      sendJson(res, 413, {
        error: `The request body exceeds the ${MAX_BODY_BYTES} bytes (10 KB) limit.`,
      });
      return;
    }
    if (body.trim() === "") {
      sendJson(res, 400, {
        error: 'The request body is empty: send JSON {"text": "<transcript>"}.',
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "The request body is not valid JSON." });
      return;
    }

    const text = (parsed as { text?: unknown } | null)?.text;
    if (typeof text !== "string") {
      sendJson(res, 400, {
        error: 'The "text" field is required and must be a string.',
      });
      return;
    }
    if (text.trim() === "") {
      sendJson(res, 400, { error: 'The "text" field cannot be empty.' });
      return;
    }

    const result = await runVoiceFlow(text);
    if (result.status === 200) {
      // `timings` goes last in the body: transcript → classification → action → timings.
      const payload: VoiceCommandResponse = {
        ...result.body,
        timings: {
          classify_ms: result.classifyMs,
          total_ms: Math.round(performance.now() - flowStart),
        },
      };
      sendJson(res, result.status, payload);
    } else {
      sendJson(res, result.status, result.body);
    }
  }

  /**
   * GET /api/status: deployment state + pod breakdown, or `503` with
   * `replicas: null`, zeroed pods and an error message if kubectl fails
   * (the body shape stays constant for the frontend).
   */
  async function handleStatus(res: ServerResponse): Promise<void> {
    try {
      const [status, pods] = await Promise.all([
        getStatus(cfg.k8sDeployment, cfg.k8sNamespace, kubectlRunner, cluster),
        podStatesReader(cfg.k8sPodSelector, cfg.k8sNamespace),
      ]);
      sendJson(res, 200, {
        deployment: cfg.k8sDeployment,
        replicas: status.replicas,
        ready_replicas: status.readyReplicas,
        pods,
      });
    } catch (error) {
      sendJson(res, 503, {
        deployment: cfg.k8sDeployment,
        replicas: null,
        ready_replicas: null,
        pods: ZERO_POD_STATES,
        error:
          `Could not query the status of deployment "${cfg.k8sDeployment}": ` +
          `${messageOf(error)}.`,
      });
    }
  }

  /** Serves static files from `public/` with a safe path join; JSON 404 otherwise. */
  async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const notFound = () => sendJson(res, 404, UNKNOWN_ROUTE_ERROR);

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      notFound();
      return;
    }
    if (decoded.includes("\0")) {
      notFound();
      return;
    }

    if (decoded === "/" || decoded === "/index.html") {
      try {
        const html = await readFile(path.join(publicDir, "index.html"), "utf8");
        sendBytes(res, 200, html, CONTENT_TYPES[".html"]);
      } catch (error) {
        if (isEnoent(error)) {
          // public/ does not exist yet (phase 2 frontend): placeholder page.
          sendBytes(res, 200, PLACEHOLDER_HTML, CONTENT_TYPES[".html"]);
        } else {
          notFound();
        }
      }
      return;
    }

    // Safe path join: the result must stay inside publicDir.
    const resolved = path.resolve(publicDir, `.${decoded}`);
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
      notFound();
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(resolved).toLowerCase()];
    if (!contentType) {
      notFound();
      return;
    }
    try {
      const data = await readFile(resolved);
      sendBytes(res, 200, data, contentType);
    } catch {
      notFound();
    }
  }

  /** Routes each request; any unrecognized route/method → JSON 404. */
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 404, UNKNOWN_ROUTE_ERROR);
      return;
    }

    if (pathname === "/api/voice-command") {
      if (req.method !== "POST") {
        sendJson(res, 404, UNKNOWN_ROUTE_ERROR);
        return;
      }
      await handleVoiceCommand(req, res);
      return;
    }

    if (pathname === "/api/status") {
      if (req.method !== "GET") {
        sendJson(res, 404, UNKNOWN_ROUTE_ERROR);
        return;
      }
      await handleStatus(res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(pathname, res);
      return;
    }

    sendJson(res, 404, UNKNOWN_ROUTE_ERROR);
  }

  return http.createServer((req, res) => {
    res.on("error", () => {});
    void route(req, res).catch((error: unknown) => {
      // Safety net against bugs: it should never be reached by kubectl/Jev
      // failures (those are caught inside the flow).
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Unexpected internal error: ${messageOf(error)}.` });
      } else {
        res.destroy();
      }
    });
  });
}

/** true only when this module is the process entry point. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// Direct startup (npm start / tsx src/server.ts): listens on config.port.
if (isDirectRun()) {
  const server = createVoiceServer();
  server.listen(config.port, () => {
    const mode = config.jevMock ? "mock" : "real";
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(
      `Voice server listening on http://localhost:${port} (Jev in ${mode} mode, ` +
        `deployment "${config.k8sDeployment}" in namespace "${config.k8sNamespace}")`,
    );
  });
}