/**
 * Tests del servidor HTTP (`createVoiceServer`) con clasificador y runner de
 * kubectl falsos inyectados: sin kubectl real, sin red más allá de localhost.
 *
 * Cada test arranca un servidor real en 127.0.0.1:0 (puerto efímero) y habla
 * con él vía `fetch`, cerrándolo al terminar.
 */

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { trafficReplicas } from "./config.js";
import { createVoiceServer } from "./server.js";
import type { PodStatesReader, ServerConfig, ServerOptions, VoiceCommandResponse } from "./server.js";
import type { Classifier, JevClassification } from "./jev.js";
import { KubectlError } from "./kubectl.js";
import type { KubectlRunner } from "./kubectl.js";

/** Config de pruebas: mismo despliegue que la demo, sin efectos reales. */
const TEST_CFG: ServerConfig = {
  port: 0,
  confidenceThreshold: 0.5,
  k8sDeployment: "nginx-voice",
  k8sNamespace: "default",
  k8sPodSelector: "app=nginx-voice",
  trafficReplicas,
  jevMock: true,
};

/** Clasificación falsa con la etiqueta dada al confidence dado. */
function classificationOf(choice: JevClassification["choice"], confidence: number): JevClassification {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

/** Espera pasiva de `ms` milisegundos (para clasificadores falsos lentos). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON realista de `kubectl get deployment -o json` para el runner falso. */
function deploymentJson(replicas: number, ready: number): string {
  return JSON.stringify({ kind: "Deployment", spec: { replicas }, status: { readyReplicas: ready } });
}

/** Clasificador falso: registra las llamadas y responde (o lanza) lo dado. */
function fakeClassifier(result: JevClassification | Error) {
  const calls: Array<{ text: string; currentReplicas: number }> = [];
  const classifier: Classifier = {
    async classify(text: string, currentReplicas: number) {
      calls.push({ text, currentReplicas });
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { classifier, calls };
}

/**
 * Runner de kubectl falso, programable por verbo: el primer `get` responde
 * `firstGet`, el segundo `secondGet` (o `firstGet` si no se dio); `scale`
 * responde `scale`. Los valores Error se lanzan tal cual (forma execFile).
 */
function fakeKubectl(options: {
  firstGet?: string | Error;
  scale?: string | Error;
  secondGet?: string | Error;
} = {}) {
  const calls: string[][] = [];
  let gets = 0;
  const runner: KubectlRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "get") {
      gets += 1;
      const spec = gets === 1 ? options.firstGet : (options.secondGet ?? options.firstGet);
      if (spec instanceof Error) throw spec;
      return { stdout: spec ?? deploymentJson(3, 2), stderr: "" };
    }
    if (args[0] === "scale") {
      if (options.scale instanceof Error) throw options.scale;
      return { stdout: options.scale ?? "deployment.apps/nginx-voice scaled", stderr: "" };
    }
    throw new Error(`comando inesperado: ${args.join(" ")}`);
  };
  return { runner, calls };
}

/** Servidor arrancado en 127.0.0.1:0 con su puerto y su cierre ordenado. */
interface Booted {
  server: http.Server;
  port: number;
  base: string;
  close: () => Promise<void>;
}

async function boot(options: ServerOptions): Promise<Booted> {
  const server = createVoiceServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "debe escuchar en un puerto efímero");
  const port = address.port;
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Arranca, ejecuta y cierra siempre, aunque el test falle. */
async function withServer(options: ServerOptions, run: (booted: Booted) => Promise<void>): Promise<void> {
  const booted = await boot(options);
  try {
    await run(booted);
  } finally {
    await booted.close();
  }
}

/** Opciones estándar de prueba con inyecciones por defecto. */
function serverOptions(
  overrides: {
    classifier: Classifier;
    kubectlRunner?: KubectlRunner;
    podStatesReader?: PodStatesReader;
    publicDir?: string;
    settleDelayMs?: number;
  },
): ServerOptions {
  return { cfg: TEST_CFG, settleDelayMs: 1, ...overrides };
}

/** POST de ayuda con cuerpo JSON. */
function postCommand(base: string, body: string | undefined): Promise<Response> {
  return fetch(`${base}/api/voice-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

/** Directorio temporal que hace de `public/`, con archivos opcionales. */
async function makePublicDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-public-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

describe("POST /api/voice-command", () => {
  it("escala a la réplicas del nivel alto y confirma réplicas antes y después", async () => {
    const { classifier, calls: classifierCalls } = fakeClassifier(classificationOf("alto", 0.92));
    const { runner, calls } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "tenemos mucho tráfico" }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.transcript, "tenemos mucho tráfico");
      assert.deepEqual(body.classification, {
        choice: "alto",
        probabilities: { alto: 0.92 },
        confidence: 0.92,
      });
      assert.deepEqual(body.action, {
        type: "scaled",
        replicas_before: 3,
        replicas_after: 10,
      });
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(body.timings.classify_ms >= 0);
      assert.deepEqual(classifierCalls, [{ text: "tenemos mucho tráfico", currentReplicas: 3 }]);
      assert.deepEqual(
        calls.filter((args) => args[0] === "scale"),
        [["scale", "deployment", "nginx-voice", "-n", "default", "--replicas=10"]],
      );
    });
  });

  it("omite el ajuste con no_se y nunca llama a kubectl scale", async () => {
    const { classifier } = fakeClassifier(classificationOf("no_se", 0.99));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 3) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "no estoy seguro" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.deepEqual(body.action, {
        type: "skipped",
        replicas_before: 3,
        replicas_after: null,
        reason: body.action.reason,
      });
      assert.match(body.action.reason ?? "", /no_se/);
      assert.equal(body.classification.choice, "no_se");
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(body.timings.classify_ms >= 0);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("mide classify_ms con un clasificador lento y total_ms >= classify_ms", async () => {
    const lento: Classifier = {
      async classify() {
        await sleep(100);
        return classificationOf("alto", 0.92);
      },
    };
    const { runner } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier: lento, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "mucho tráfico" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.classification.choice, "alto");
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(
        body.timings.classify_ms >= 50,
        `classify_ms=${body.timings.classify_ms}, esperado >= 50 (clasificador de ~100 ms)`,
      );
      assert.ok(
        body.timings.total_ms >= body.timings.classify_ms,
        `total_ms=${body.timings.total_ms} debe cubrir classify_ms=${body.timings.classify_ms}`,
      );
      assert.deepEqual(Object.keys(body), [
        "transcript",
        "classification",
        "action",
        "timings",
      ]);
    });
  });

  it("omite el ajuste cuando la confianza queda por debajo del umbral", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.3));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 3) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "mucho tráfico" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "skipped");
      assert.match(body.action.reason ?? "", /por debajo del umbral/);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("usa 0 réplicas para el clasificador y null como réplicas previas cuando el get inicial falla", async () => {
    const { classifier, calls: classifierCalls } = fakeClassifier(classificationOf("alto", 0.92));
    const { runner } = fakeKubectl({
      firstGet: new Error("cluster caído"),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "mucho tráfico" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.deepEqual(body.action, {
        type: "scaled",
        replicas_before: null,
        replicas_after: 10,
      });
      assert.deepEqual(classifierCalls, [{ text: "mucho tráfico", currentReplicas: 0 }]);
    });
  });

  it("devuelve 200 con action.type 'error' cuando kubectl scale falla, conservando la clasificación", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.92));
    const { runner } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      scale: new KubectlError("kubectl_failed", "connection refused"),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "mucho tráfico" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "error");
      assert.equal(body.action.replicas_before, 3);
      assert.equal(body.action.replicas_after, null);
      assert.match(body.action.reason ?? "", /No se pudo escalar/);
      assert.match(body.action.reason ?? "", /connection refused/);
      assert.equal(body.classification.choice, "alto");
      assert.equal(body.transcript, "mucho tráfico");
    });
  });

  it("devuelve 200 con action.type 'error' cuando no se puede confirmar el estado tras escalar", async () => {
    const { classifier } = fakeClassifier(classificationOf("normal", 0.9));
    const { runner, calls } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: new Error("get tardó demasiado"),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "tráfico normal" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "error");
      assert.equal(body.action.replicas_after, null);
      assert.match(body.action.reason ?? "", /no se pudo confirmar/);
      assert.equal(body.classification.choice, "normal");
      assert.equal(calls.some((args) => args[0] === "scale"), true, "el scale sí se envió");
    });
  });

  it("devuelve 502 con error en español cuando el clasificador falla, sin escalar", async () => {
    const { classifier } = fakeClassifier(new Error("Jev fuera de servicio"));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 2) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "mucho tráfico" }));
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /No se pudo clasificar/);
      assert.match(body.error, /Jev fuera de servicio/);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("rechaza con 400 un cuerpo vacío", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, undefined);
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.ok(body.error.length > 0, "el error debe tener mensaje en español");
    });
  });

  it("rechaza con 400 cuando falta el campo text", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ otro: 1 }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /text/);
    });
  });

  it("rechaza con 400 cuando text no es una cadena", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: 42 }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /cadena/);
    });
  });

  it("rechaza con 400 cuando text está vacío", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "   " }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /no puede estar vacío/);
    });
  });

  it("rechaza con 400 un cuerpo que no es JSON válido", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, "esto no es json");
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /JSON/);
    });
  });

  it("responde 413 cuando el cuerpo supera los 10 KB, sin tocar kubectl", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const { runner, calls } = fakeKubectl({});
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "a".repeat(11 * 1024) }));
      assert.equal(response.status, 413);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /10 KB/);
      assert.equal(calls.length, 0, "ninguna llamada a kubectl con cuerpo demasiado grande");
    });
  });
});

describe("GET /api/status", () => {
  it("devuelve el estado del despliegue con el desglose de pods del lector inyectado", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const { runner } = fakeKubectl({ firstGet: deploymentJson(3, 2) });
    const readerCalls: Array<{ podSelector: string; namespace: string }> = [];
    await withServer(
      serverOptions({
        classifier,
        kubectlRunner: runner,
        podStatesReader: async (podSelector, namespace) => {
          readerCalls.push({ podSelector, namespace });
          return { running: 2, starting: 1, terminating: 0 };
        },
      }),
      async ({ base }) => {
        const response = await fetch(`${base}/api/status`);
        assert.equal(response.status, 200);
        const body = (await response.json()) as {
          deployment: string;
          replicas: number | null;
          ready_replicas: number | null;
          pods: { running: number; starting: number; terminating: number };
        };
        assert.deepEqual(body, {
          deployment: "nginx-voice",
          replicas: 3,
          ready_replicas: 2,
          pods: { running: 2, starting: 1, terminating: 0 },
        });
        assert.deepEqual(readerCalls, [
          { podSelector: "app=nginx-voice", namespace: "default" },
        ]);
      },
    );
  });

  it("devuelve 503 con réplicas null y pods en ceros cuando kubectl falla", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const { runner } = fakeKubectl({ firstGet: new KubectlError("kubectl_failed", "no hay clúster") });
    await withServer(
      serverOptions({
        classifier,
        kubectlRunner: runner,
        // Aunque el lector de pods tenga datos, el fallo del despliegue manda:
        // la forma del cuerpo 503 debe ser constante para el frontend.
        podStatesReader: async () => ({ running: 5, starting: 0, terminating: 0 }),
      }),
      async ({ base }) => {
        const response = await fetch(`${base}/api/status`);
        assert.equal(response.status, 503);
        const body = (await response.json()) as {
          deployment: string;
          replicas: number | null;
          ready_replicas: number | null;
          pods: { running: number; starting: number; terminating: number } | null;
          error: string;
        };
        assert.equal(body.deployment, "nginx-voice");
        assert.equal(body.replicas, null);
        assert.equal(body.ready_replicas, null);
        assert.deepEqual(body.pods, { running: 0, starting: 0, terminating: 0 });
        assert.match(body.error, /No se pudo consultar/);
        assert.match(body.error, /no hay clúster/);
      },
    );
  });

  it("devuelve 503 con pods en ceros cuando el lector de pods falla", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const { runner } = fakeKubectl({ firstGet: deploymentJson(3, 2) });
    await withServer(
      serverOptions({
        classifier,
        kubectlRunner: runner,
        podStatesReader: async () => {
          throw new KubectlError("kubectl_failed", "lista de pods rota");
        },
      }),
      async ({ base }) => {
        const response = await fetch(`${base}/api/status`);
        assert.equal(response.status, 503);
        const body = (await response.json()) as {
          replicas: number | null;
          pods: { running: number; starting: number; terminating: number } | null;
        };
        assert.equal(body.replicas, null);
        assert.deepEqual(body.pods, { running: 0, starting: 0, terminating: 0 });
      },
    );
  });
});

describe("rutas y estáticos", () => {
  it("devuelve 404 JSON para rutas desconocidas", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/api/desconocida`);
        assert.equal(response.status, 404);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const body = (await response.json()) as { error: string };
        assert.ok(body.error.length > 0);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("devuelve 404 con método incorrecto en una ruta conocida", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const postStatus = await fetch(`${base}/api/status`, { method: "POST" });
        assert.equal(postStatus.status, 404);
        const getStatus = await fetch(`${base}/api/voice-command`);
        assert.equal(getStatus.status, 404);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("sirve una página de reserva en / cuando no existe public/index.html", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        const html = await response.text();
        assert.match(html, /<!doctype html>/i);
        assert.match(html, /fase 2/, "la página de reserva menciona la fase 2");
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("sirve index.html, css y js desde public/ con el content-type correcto", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir({
      "index.html": "<h1>hola desde public</h1>",
      "style.css": "body { color: red; }",
      "app.js": "console.log('demo');",
    });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const home = await fetch(`${base}/`);
        assert.equal(home.status, 200);
        assert.equal(await home.text(), "<h1>hola desde public</h1>");
        assert.match(home.headers.get("content-type") ?? "", /text\/html/);

        const explicit = await fetch(`${base}/index.html`);
        assert.equal(explicit.status, 200);

        const css = await fetch(`${base}/style.css`);
        assert.equal(css.status, 200);
        assert.match(css.headers.get("content-type") ?? "", /text\/css/);

        const js = await fetch(`${base}/app.js`);
        assert.equal(js.status, 200);
        assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("devuelve 404 para estáticos inexistentes", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/no-existe.css`);
        assert.equal(response.status, 404);
        const body = (await response.json()) as { error: string };
        assert.ok(body.error.length > 0);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("devuelve 404 para extensiones sin tipo conocido", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir({ "notas.txt": "secreto" });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/notas.txt`);
        assert.equal(response.status, 404);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("bloquea el path traversal fuera de public/", async () => {
    const { classifier } = fakeClassifier(classificationOf("alto", 0.9));
    const publicDir = await makePublicDir({ "index.html": "<h1>hola</h1>" });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        // %2F codificado evita que el cliente normalice los puntos: llega tal
        // cual al servidor, que debe rechazarlo por salir de public/.
        const traversal = await fetch(`${base}/x/%2F..%2F..%2Fserver.ts`);
        assert.equal(traversal.status, 404);
        const simple = await fetch(`${base}/../server.ts`);
        assert.equal(simple.status, 404);
        const badEscape = await fetch(`${base}/%zz`);
        assert.equal(badEscape.status, 404);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });
});
