/**
 * Servidor HTTP de la demo (sin frameworks, solo `node:http`).
 *
 * Rutas:
 * - `GET /` y estáticos bajo `public/`: frontend de la demo. Si aún no existe
 *   `public/index.html` se sirve una página de reserva en español (el frontend
 *   llega en la fase 2). Nunca se sirve nada fuera de `public/` (path join
 *   seguro con verificación de prefijo) y solo con tipos de contenido
 *   conocidos (.html/.css/.js/.svg/.png); cualquier otra cosa → 404 JSON.
 * - `POST /api/voice-command`: recibe `{"text": "..."}`, consulta el estado
 *   actual del despliegue, clasifica con Jev, decide con la política y escala
 *   con kubectl. Regla de resiliencia de la demo: ni kubectl ni Jev provocan
 *   un 500 — un fallo de clasificación degrada a `502` con `{error}` y un
 *   fallo de kubectl a mitad del flujo degrada a `200` con
 *   `action.type: "error"` y la clasificación intacta. La respuesta `200`
 *   incluye `timings` (`classify_ms` y `total_ms`, ms enteros) para mostrar
 *   en pantalla cuánto tardó Jev en decidir.
 * - `GET /api/status`
 * - `GET /api/status`: estado actual del despliegue más el desglose de pods
 *   (`pods: {running, starting, terminating}`), o `503` con réplicas `null`,
 *   pods en ceros y un mensaje de error en español si kubectl falla.
 *
 * El servidor no escucha al importarse: `createVoiceServer` devuelve un
 * `http.Server` (inyectable para tests) y solo el guard de ejecución directa
 * llama a `listen` con `config.port`, registrando el modo de Jev (mock/real).
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
 * Dependencia inyectable que consulta el desglose de estados de pods
 * (`getPodStates` sobre el runner por defecto, o un doble en tests).
 */
export type PodStatesReader = (
  podSelector: string,
  namespace: string,
) => Promise<PodStates>;

/** Configuración que el servidor necesita (estructuralmente compatible con `config`). */
export interface ServerConfig {
  /** Puerto de escucha en arranque directo. */
  port: number;
  /** Umbral de confianza de la política de escalado. */
  confidenceThreshold: number;
  /** Nombre del despliegue de Kubernetes. */
  k8sDeployment: string;
  /** Namespace de Kubernetes. */
  k8sNamespace: string;
  /** Selector de pods para el desglose de estados (GET /api/status). */
  k8sPodSelector: string;
  /** Ruta opcional a un kubeconfig de un cluster externo (K8S_KUBECONFIG);
   *  ausente/vacía = kubectl usa su kubeconfig por defecto. */
  k8sKubeconfig?: string;
  /** Contexto opcional dentro del kubeconfig (K8S_CONTEXT); ausente/vacío =
   *  kubectl usa el contexto actual. */
  k8sContext?: string;
  /** Réplicas objetivo por nivel de tráfico. */
  trafficReplicas: Readonly<Record<TrafficLevel, number>>;
  /** true si Jev corre en modo mock (determinista, sin red). */
  jevMock: boolean;
}

/** Opciones de la fábrica del servidor: todo inyectable para tests. */
export interface ServerOptions {
  /** Configuración; por defecto la `config` central del proyecto. */
  cfg?: ServerConfig;
  /** Clasificador; por defecto `createClassifier(cfg)` (mock o real). */
  classifier?: Classifier;
  /** Runner de kubectl; por defecto `execFile("kubectl", ...)` sin shell. */
  kubectlRunner?: KubectlRunner;
  /**
   * Lector del desglose de estados de pods para `/api/status`; por defecto
   * `getPodStates(k8sPodSelector, k8sNamespace)` sobre el runner de kubectl.
   */
  podStatesReader?: PodStatesReader;
  /** Directorio de estáticos; por defecto `public/` junto a la raíz del repo. */
  publicDir?: string;
  /** Espera tras `kubectl scale` antes de releer el estado (ms). */
  settleDelayMs?: number;
}

/** Parte `action` de la respuesta de `/api/voice-command`. */
export interface VoiceCommandAction {
  type: "scaled" | "skipped" | "error";
  replicas_before: number | null;
  replicas_after: number | null;
  reason?: string;
}

/** Parte `timings` de la respuesta `200` de `/api/voice-command` (ms enteros). */
export interface VoiceCommandTimings {
  /** Milisegundos que tardó Jev en clasificar la transcripción. */
  classify_ms: number;
  /** Milisegundos del flujo completo, del inicio del handler a la respuesta. */
  total_ms: number;
}

/** Forma completa de la respuesta `200` de `/api/voice-command`. */
export interface VoiceCommandResponse {
  transcript: string;
  classification: {
    choice: JevClassification["choice"];
    probabilities: Record<string, number>;
    confidence: number;
  };
  action: VoiceCommandAction;
  /** Tiempos de la demo: el frontend muestra `classify_ms` junto a la confianza. */
  timings: VoiceCommandTimings;
}

/** Límite de cuerpo para `POST /api/voice-command` (~10 KB). */
const MAX_BODY_BYTES = 10 * 1024;

/** Desglose de pods en ceros: forma constante del cuerpo ante fallo. */
const PODS_EN_CEROS: PodStates = { running: 0, starting: 0, terminating: 0 };

/** Tope absoluto de drenaje antes de cortar un cuerpo demasiado grande. */
const HARD_DRAIN_CAP_BYTES = 1024 * 1024;

/** Espera por defecto tras escalar, para dar aire a kubectl en la demo. */
const DEFAULT_SETTLE_DELAY_MS = 500;

/** Tipos de contenido servidos desde `public/`; cualquier otra extensión → 404. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Página de reserva mientras el frontend (fase 2) no exista. */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo: comando de voz con Jev y kubectl</title>
  </head>
  <body>
    <h1>Demo: comando de voz con Jev y kubectl</h1>
    <p>El frontend llega en la fase 2. El backend ya responde:</p>
    <ul>
      <li><code>POST /api/voice-command</code> con <code>{"text": "&lt;transcripci&oacute;n&gt;"}</code></li>
      <li><code>GET /api/status</code></li>
    </ul>
  </body>
</html>
`;

/** Mensaje único para cualquier ruta/método no reconocido. */
const UNKNOWN_ROUTE_ERROR = { error: "Ruta no encontrada." };

/** Extrae el mensaje de un error desconocido de forma segura. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ¿Es el error clásico "no existe el archivo"? */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Espera pasiva de `ms` milisegundos. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Envía un cuerpo con el status y content-type dados (content-length incluido). */
function sendBytes(res: ServerResponse, status: number, body: string | Buffer, contentType: string): void {
  if (res.destroyed) return;
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, { "content-type": contentType, "content-length": payload.length });
  res.end(payload);
}

/** Envía JSON con charset utf-8. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendBytes(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

/**
 * Lee el cuerpo de la petición con límite de tamaño.
 *
 * Si el cuerpo supera `MAX_BODY_BYTES`, se marca como demasiado grande pero se
 * sigue drenando (hasta `HARD_DRAIN_CAP_BYTES`) antes de responder, para que
 * el cliente llegue a recibir el `413` en lugar de un reset de conexión.
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
 * Crea el servidor HTTP con todas las dependencias inyectables.
 *
 * No escucha: el llamador decide el puerto (`server.listen`). El arranque
 * directo al final de este módulo es el único que usa `config.port`.
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

  /** Selección de cluster externo (kubeconfig/contexto) para cada llamada a kubectl. */
  const cluster = { kubeconfig: cfg.k8sKubeconfig, context: cfg.k8sContext };

  /**
   * Resultado del flujo de voz: `200` con la respuesta completa, o `502` con
   * `{error}` cuando el clasificador falla (nunca un 500 por Jev/kubectl).
   */
  type FlowResult =
    | { status: 200; body: Omit<VoiceCommandResponse, "timings">; classifyMs: number }
    | { status: 502; body: { error: string } };

  /** Consulta el estado actual; ante fallo devuelve null (resiliencia de demo). */
  async function statusOrReplicasBefore(): Promise<number | null> {
    try {
      const status = await getStatus(cfg.k8sDeployment, cfg.k8sNamespace, kubectlRunner, cluster);
      return status.replicas;
    } catch {
      return null;
    }
  }

  /** Flujo completo: estado previo → clasificar → decidir → escalar → confirmar. */
  async function runVoiceFlow(text: string): Promise<FlowResult> {
    const replicasBefore = await statusOrReplicasBefore();
    // Sin estado previo (kubectl ausente o con fallo) el clasificador recibe 0.
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
            `No se pudo clasificar la transcripción con Jev: ${messageOf(error)}. ` +
            "No se ajustaron las réplicas.",
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
              `No se pudo escalar el despliegue "${cfg.k8sDeployment}" a ${decision.replicas} réplicas: ` +
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
              `El escalado a ${decision.replicas} réplicas se envió, pero no se pudo confirmar ` +
              `el estado del despliegue: ${messageOf(error)}.`,
          },
        },
        classifyMs,
      };
    }
  }

  /** POST /api/voice-command: valida el cuerpo y ejecuta el flujo de voz. */
  async function handleVoiceCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const flowStart = performance.now();
    const { ok, body } = await readBody(req);
    if (!ok) {
      sendJson(res, 413, {
        error: `El cuerpo de la petición supera el límite de ${MAX_BODY_BYTES} bytes (10 KB).`,
      });
      return;
    }
    if (body.trim() === "") {
      sendJson(res, 400, {
        error: 'El cuerpo de la petición está vacío: envía JSON {"text": "<transcripción>"}.',
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "El cuerpo de la petición no es JSON válido." });
      return;
    }

    const text = (parsed as { text?: unknown } | null)?.text;
    if (typeof text !== "string") {
      sendJson(res, 400, {
        error: 'El campo "text" es obligatorio y debe ser una cadena de texto.',
      });
      return;
    }
    if (text.trim() === "") {
      sendJson(res, 400, { error: 'El campo "text" no puede estar vacío.' });
      return;
    }

    const result = await runVoiceFlow(text);
    if (result.status === 200) {
      // `timings` va último en el cuerpo: transcript → classification → action → timings.
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
   * GET /api/status: estado del despliegue + desglose de pods, o `503` con
   * réplicas null, pods en ceros y un mensaje de error en español si kubectl
   * falla (la forma del cuerpo queda constante para el frontend).
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
        pods: PODS_EN_CEROS,
        error:
          `No se pudo consultar el estado del despliegue "${cfg.k8sDeployment}": ` +
          `${messageOf(error)}.`,
      });
    }
  }

  /** Sirve estáticos de `public/` con path join seguro; 404 JSON si no procede. */
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
          // public/ aún no existe (frontend de la fase 2): página de reserva.
          sendBytes(res, 200, PLACEHOLDER_HTML, CONTENT_TYPES[".html"]);
        } else {
          notFound();
        }
      }
      return;
    }

    // Path join seguro: el resultado debe quedar dentro de publicDir.
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

  /** Enruta cada petición; cualquier ruta/método no reconocido → 404 JSON. */
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
      // Red de seguridad ante bugs: nunca debería alcanzarse por fallos de
      // kubectl/Jev (esos se capturan dentro del flujo).
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Error interno inesperado: ${messageOf(error)}.` });
      } else {
        res.destroy();
      }
    });
  });
}

/** true solo cuando este módulo es el punto de entrada del proceso. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// Arranque directo (npm start / tsx src/server.ts): escucha en config.port.
if (isDirectRun()) {
  const server = createVoiceServer();
  server.listen(config.port, () => {
    const mode = config.jevMock ? "mock" : "real";
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(
      `Servidor de voz escuchando en http://localhost:${port} (Jev en modo ${mode}, ` +
        `despliegue "${config.k8sDeployment}" en el namespace "${config.k8sNamespace}")`,
    );
  });
}
