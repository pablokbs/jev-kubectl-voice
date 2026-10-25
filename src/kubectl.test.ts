/**
 * Tests del envoltorio de kubectl (`getStatus`, `scaleDeployment`, mapeo de
 * errores) con un runner falso inyectado: sin kubectl real ni clúster.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KubectlError, getPodStates, getStatus, scaleDeployment } from "./kubectl.js";
import type { KubectlRunner } from "./kubectl.js";

/** Payload JSON realista de `kubectl get deployment -o json`. */
const DEPLOYMENT_JSON = JSON.stringify({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "nginx-voice",
    namespace: "default",
    uid: "1b08c3e2-9f4a-4d17-b6a2-6f4b2f9c1d55",
    resourceVersion: "4213",
    creationTimestamp: "2025-01-15T10:03:00Z",
  },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: "nginx-voice" } },
    template: {
      metadata: { labels: { app: "nginx-voice" } },
      spec: { containers: [{ name: "nginx", image: "nginx:1.25" }] },
    },
  },
  status: {
    observedGeneration: 2,
    replicas: 3,
    readyReplicas: 2,
    availableReplicas: 2,
    updatedReplicas: 2,
  },
});

/**
 * Runner falso que registra cada invocación y responde con un resultado fijo
 * (o rechaza con el error dado, con forma de fallo de execFile).
 */
function fakeRunner(response: { stdout?: string; stderr?: string } | Error) {
  const calls: string[][] = [];
  const runner: KubectlRunner = async (args) => {
    calls.push([...args]);
    if (response instanceof Error) throw response;
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
  return { runner, calls };
}

/** Error con forma de fallo de `execFile` promisificado (código + stderr). */
function execLikeError(props: {
  code?: string | number;
  stderr?: string;
  message?: string;
}): Error {
  return Object.assign(new Error(props.message ?? "kubectl failed"), {
    code: props.code,
    stderr: props.stderr,
  });
}

/** Runner falso que rechaza siempre con un error con forma de execFile. */
function failingRunner(props: { code?: string | number; stderr?: string; message?: string }) {
  return fakeRunner(execLikeError(props));
}

describe("getStatus", () => {
  it("parsea la salida JSON de kubectl en un estado tipado", async () => {
    const { runner } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 3, readyReplicas: 2 });
  });

  it("invoca kubectl con el array de argumentos esperado, sin shell", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "los argumentos deben viajar como array");
    assert.deepStrictEqual(calls[0], [
      "get",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "-o",
      "json",
    ]);
  });

  it("usa 0 por defecto cuando falta status.readyReplicas", async () => {
    const payload = JSON.stringify({
      kind: "Deployment",
      spec: { replicas: 3 },
      status: { observedGeneration: 1 },
    });
    const { runner } = fakeRunner({ stdout: payload });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 3, readyReplicas: 0 });
  });

  it("usa 0 por defecto cuando falta spec.replicas (y en el documento vacío)", async () => {
    const { runner } = fakeRunner({ stdout: JSON.stringify({ kind: "Deployment" }) });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 0, readyReplicas: 0 });
  });

  it("mapea ENOENT a kubectl_unavailable", async () => {
    const { runner } = failingRunner({
      code: "ENOENT",
      stderr: "",
      message: "spawn kubectl ENOENT",
    });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "kubectl_unavailable");
      assert.equal(error.exitCode, undefined);
      return true;
    });
  });

  it("mapea stderr con NotFound a not_found, conservando stderr y código de salida", async () => {
    const stderr =
      'Error from server (NotFound): deployments.apps "nginx-voice" not found';
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "not_found");
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderr, stderr);
      return true;
    });
  });

  it("mapea un fallo genérico a kubectl_failed con el stderr capturado", async () => {
    const stderr = "The connection to the server localhost:8080 was refused";
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.equal(error.exitCode, 1);
      assert.ok(
        error.stderr?.includes("localhost:8080"),
        `el stderr debe capturarse, recibió: ${error.stderr}`,
      );
      return true;
    });
  });

  it("falla con kubectl_failed y contexto de parseo cuando kubectl devuelve JSON malformado", async () => {
    const { runner } = fakeRunner({ stdout: "no-es-json { corte" });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.match(error.message, /JSON/);
      assert.match(error.message, /no-es-json/, "el mensaje debe incluir la salida cruda");
      assert.equal(error.exitCode, undefined, "el proceso terminó bien; no hay código de salida");
      return true;
    });
  });

  it("repropaga un KubectlError del runner tal cual, sin reenvolverlo", async () => {
    const original = new KubectlError("kubectl_failed", "boom", { stderr: "detalle" });
    const { runner } = fakeRunner(original);
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError);
      assert.equal(error.kind, "kubectl_failed");
      assert.equal(error.stderr, "detalle");
      assert.match(error.message, /boom/);
      return true;
    });
  });
});

/**
 * Fabrica la lista JSON de `kubectl get pods -o json` a partir de specs
 * compactos: cada entrada describe un pod de la demo.
 */
function podsJson(
  pods: Array<{
    phase?: string;
    deletionTimestamp?: string;
    containerStatuses?: Array<{ ready: boolean }>;
  }>,
): string {
  return JSON.stringify({
    kind: "List",
    items: pods.map((spec, index) => ({
      metadata: {
        name: `nginx-voice-${index}`,
        ...(spec.deletionTimestamp === undefined
          ? {}
          : { deletionTimestamp: spec.deletionTimestamp }),
      },
      status: {
        ...(spec.phase === undefined ? {} : { phase: spec.phase }),
        ...(spec.containerStatuses === undefined
          ? {}
          : { containerStatuses: spec.containerStatuses }),
      },
    })),
  });
}

describe("getPodStates", () => {
  it("cuenta 3 pods corriendo como {running: 3, starting: 0, terminating: 0}", async () => {
    const { runner } = fakeRunner({
      stdout: podsJson([
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: true }] },
      ]),
    });
    const states = await getPodStates("app=nginx-voice", "default", runner);
    assert.deepStrictEqual(states, { running: 3, starting: 0, terminating: 0 });
  });

  it("cuenta pods Pending sin containerStatuses como starting", async () => {
    const { runner } = fakeRunner({
      stdout: podsJson([
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Pending" },
        { phase: "Pending" },
      ]),
    });
    const states = await getPodStates("app=nginx-voice", "default", runner);
    assert.deepStrictEqual(states, { running: 3, starting: 2, terminating: 0 });
  });

  it("clasifica terminating / running / Running-no-listo como {1, 1, 1}", async () => {
    const { runner } = fakeRunner({
      stdout: podsJson([
        { phase: "Running", deletionTimestamp: "2025-01-15T10:30:00Z", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: true }] },
        { phase: "Running", containerStatuses: [{ ready: false }] },
      ]),
    });
    const states = await getPodStates("app=nginx-voice", "default", runner);
    assert.deepStrictEqual(states, { running: 1, starting: 1, terminating: 1 });
  });

  it("devuelve todo en ceros cuando items falta o está vacío", async () => {
    for (const stdout of [JSON.stringify({ kind: "List" }), JSON.stringify({ kind: "List", items: [] })]) {
      const { runner } = fakeRunner({ stdout });
      const states = await getPodStates("app=nginx-voice", "default", runner);
      assert.deepStrictEqual(states, { running: 0, starting: 0, terminating: 0 });
    }
  });

  it("falla con kubectl_failed cuando la salida no es JSON", async () => {
    const { runner } = fakeRunner({ stdout: "error interno del apiserver {" });
    await assert.rejects(getPodStates("app=nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.match(error.message, /JSON/);
      return true;
    });
  });

  it("invoca `kubectl get pods` con -l, -n y -o json como array, sin shell", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=nginx-voice", "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "los argumentos deben viajar como array");
    assert.equal(calls[0][0], "get");
    assert.equal(calls[0][1], "pods");
    assert.ok(calls[0].includes("-l"), "debe incluir -l");
    assert.ok(calls[0].includes("app=nginx-voice"), "el selector debe viajar como argumento");
    assert.ok(calls[0].includes("-o"));
    assert.ok(calls[0].includes("json"));
    assert.ok(!calls[0].some((arg) => arg.includes(" ")), "ningún argumento debe contener espacios (sin shell)");
  });

  it("honra el selector pasado (override del entorno)", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=otro", "otro-ns", runner);
    assert.deepStrictEqual(calls[0], [
      "get",
      "pods",
      "-l",
      "app=otro",
      "-n",
      "otro-ns",
      "-o",
      "json",
    ]);
  });

  it("mapea un fallo de ejecución de kubectl igual que getStatus", async () => {
    const { runner } = failingRunner({ code: 1, stderr: "connection refused" });
    await assert.rejects(getPodStates("app=nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError);
      assert.equal(error.kind, "kubectl_failed");
      return true;
    });
  });
});

describe("scaleDeployment", () => {
  it("invoca kubectl con un array de argumentos exacto, nunca una cadena de shell", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 6, "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "los argumentos deben viajar como array");
    assert.equal(calls[0].length, 6);
    assert.deepStrictEqual(calls[0], [
      "scale",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "--replicas=6",
    ]);
  });

  it("rechaza réplicas inválidas antes de llamar al runner", async () => {
    const { runner, calls } = fakeRunner({ stdout: "" });
    for (const replicas of [1.5, -1, NaN, Infinity, -0.5]) {
      await assert.rejects(scaleDeployment("nginx-voice", replicas, "default", runner), {
        name: "TypeError",
      });
    }
    assert.equal(calls.length, 0, "ninguna réplica inválida debe llegar a kubectl");
  });

  it("acepta 0 réplicas (escala a cero)", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 0, "default", runner);
    assert.deepStrictEqual(calls[0], [
      "scale",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "--replicas=0",
    ]);
  });

  it("mapea NotFound a not_found también al escalar", async () => {
    const stderr = 'Error from server (NotFound): deployments.apps "nginx-voice" not found';
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(scaleDeployment("nginx-voice", 6, "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "debe lanzar un KubectlError");
      assert.equal(error.kind, "not_found");
      assert.equal(error.exitCode, 1);
      return true;
    });
  });
});

/**
 * Selección de cluster externo: los flags `--kubeconfig`/`--context` se
 * añaden al final del array de argumentos (kubectl acepta sus flags globales
 * después de los argumentos del comando), como elementos separados y sin
 * shell. Sin cluster configurado, el argv queda exactamente como antes.
 */
describe("selección de cluster externo (--kubeconfig / --context)", () => {
  it("getStatus añade --kubeconfig al final del argv", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner, { kubeconfig: "/tmp/mi-cluster.yaml" });
    assert.deepStrictEqual(calls[0], [
      "get",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "-o",
      "json",
      "--kubeconfig",
      "/tmp/mi-cluster.yaml",
    ]);
  });

  it("getPodStates añade --kubeconfig al final del argv", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=nginx-voice", "default", runner, { kubeconfig: "/tmp/mi-cluster.yaml" });
    assert.deepStrictEqual(calls[0], [
      "get",
      "pods",
      "-l",
      "app=nginx-voice",
      "-n",
      "default",
      "-o",
      "json",
      "--kubeconfig",
      "/tmp/mi-cluster.yaml",
    ]);
  });

  it("scaleDeployment añade --context al final del argv", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 6, "default", runner, { context: "prod" });
    assert.deepStrictEqual(calls[0], [
      "scale",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "--replicas=6",
      "--context",
      "prod",
    ]);
  });

  it("con ambos definidos añade --kubeconfig y luego --context, en orden determinista", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 3, "default", runner, {
      kubeconfig: "/tmp/mi-cluster.yaml",
      context: "prod",
    });
    assert.deepStrictEqual(calls[0].slice(-4), [
      "--kubeconfig",
      "/tmp/mi-cluster.yaml",
      "--context",
      "prod",
    ]);
  });

  it("getStatus con ambos definidos mantiene el orden kubeconfig → context", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner, {
      kubeconfig: "/tmp/mi-cluster.yaml",
      context: "prod",
    });
    assert.deepStrictEqual(calls[0], [
      "get",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "-o",
      "json",
      "--kubeconfig",
      "/tmp/mi-cluster.yaml",
      "--context",
      "prod",
    ]);
  });

  it("un cluster vacío ({} o undefined) no añade ningún flag", async () => {
    const { runner: runnerA, calls: callsA } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runnerA, {});
    assert.ok(!callsA[0].some((arg) => arg.startsWith("--kubeconfig") || arg.startsWith("--context")));

    const { runner: runnerB, calls: callsB } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runnerB, undefined);
    assert.ok(!callsB[0].some((arg) => arg.startsWith("--kubeconfig") || arg.startsWith("--context")));
  });
});
