/**
 * Tests of the kubectl wrapper (`getStatus`, `scaleDeployment`, error
 * mapping) with an injected fake runner: no real kubectl or cluster.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KubectlError, getPodStates, getStatus, scaleDeployment } from "./kubectl.js";
import type { KubectlRunner } from "./kubectl.js";

/** Realistic `kubectl get deployment -o json` payload. */
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
 * Fake runner that records every invocation and answers with a fixed result
 * (or rejects with the given error, shaped like an execFile failure).
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

/** Error shaped like a promisified `execFile` failure (code + stderr). */
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

/** Fake runner that always rejects with an execFile-shaped error. */
function failingRunner(props: { code?: string | number; stderr?: string; message?: string }) {
  return fakeRunner(execLikeError(props));
}

describe("getStatus", () => {
  it("parses kubectl's JSON output into a typed status", async () => {
    const { runner } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 3, readyReplicas: 2 });
  });

  it("invokes kubectl with the expected argument array, without a shell", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "arguments must travel as an array");
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

  it("uses 0 by default when status.readyReplicas is missing", async () => {
    const payload = JSON.stringify({
      kind: "Deployment",
      spec: { replicas: 3 },
      status: { observedGeneration: 1 },
    });
    const { runner } = fakeRunner({ stdout: payload });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 3, readyReplicas: 0 });
  });

  it("uses 0 by default when spec.replicas is missing (and on the empty document)", async () => {
    const { runner } = fakeRunner({ stdout: JSON.stringify({ kind: "Deployment" }) });
    const status = await getStatus("nginx-voice", "default", runner);
    assert.deepStrictEqual(status, { replicas: 0, readyReplicas: 0 });
  });

  it("maps ENOENT to kubectl_unavailable", async () => {
    const { runner } = failingRunner({
      code: "ENOENT",
      stderr: "",
      message: "spawn kubectl ENOENT",
    });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "kubectl_unavailable");
      assert.equal(error.exitCode, undefined);
      return true;
    });
  });

  it("maps stderr with NotFound to not_found, preserving stderr and exit code", async () => {
    const stderr =
      'Error from server (NotFound): deployments.apps "nginx-voice" not found';
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "not_found");
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderr, stderr);
      return true;
    });
  });

  it("maps a generic failure to kubectl_failed with the captured stderr", async () => {
    const stderr = "The connection to the server localhost:8080 was refused";
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.equal(error.exitCode, 1);
      assert.ok(
        error.stderr?.includes("localhost:8080"),
        `stderr must be captured, got: ${error.stderr}`,
      );
      return true;
    });
  });

  it("fails with kubectl_failed and parsing context when kubectl returns malformed JSON", async () => {
    const { runner } = fakeRunner({ stdout: "not-json { broken" });
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.match(error.message, /JSON/);
      assert.match(error.message, /not-json/, "the message must include the raw output");
      assert.equal(error.exitCode, undefined, "the process exited fine; no exit code");
      return true;
    });
  });

  it("re-propagates a KubectlError from the runner as-is, without re-wrapping it", async () => {
    const original = new KubectlError("kubectl_failed", "boom", { stderr: "detail" });
    const { runner } = fakeRunner(original);
    await assert.rejects(getStatus("nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError);
      assert.equal(error.kind, "kubectl_failed");
      assert.equal(error.stderr, "detail");
      assert.match(error.message, /boom/);
      return true;
    });
  });
});

/**
 * Builds the `kubectl get pods -o json` list from compact specs:
 * each entry describes a demo pod.
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
  it("counts 3 running pods as {running: 3, starting: 0, terminating: 0}", async () => {
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

  it("counts Pending pods without containerStatuses as starting", async () => {
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

  it("classifies terminating / running / Running-not-ready as {1, 1, 1}", async () => {
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

  it("returns all zeros when items is missing or empty", async () => {
    for (const stdout of [JSON.stringify({ kind: "List" }), JSON.stringify({ kind: "List", items: [] })]) {
      const { runner } = fakeRunner({ stdout });
      const states = await getPodStates("app=nginx-voice", "default", runner);
      assert.deepStrictEqual(states, { running: 0, starting: 0, terminating: 0 });
    }
  });

  it("fails with kubectl_failed when the output is not JSON", async () => {
    const { runner } = fakeRunner({ stdout: "apiserver internal error {" });
    await assert.rejects(getPodStates("app=nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "kubectl_failed");
      assert.match(error.message, /JSON/);
      return true;
    });
  });

  it("invokes `kubectl get pods` with -l, -n and -o json as an array, without a shell", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=nginx-voice", "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "arguments must travel as an array");
    assert.equal(calls[0][0], "get");
    assert.equal(calls[0][1], "pods");
    assert.ok(calls[0].includes("-l"), "must include -l");
    assert.ok(calls[0].includes("app=nginx-voice"), "the selector must travel as an argument");
    assert.ok(calls[0].includes("-o"));
    assert.ok(calls[0].includes("json"));
    assert.ok(!calls[0].some((arg) => arg.includes(" ")), "no argument may contain spaces (no shell)");
  });

  it("honours the passed selector (override of the environment)", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=other", "other-ns", runner);
    assert.deepStrictEqual(calls[0], [
      "get",
      "pods",
      "-l",
      "app=other",
      "-n",
      "other-ns",
      "-o",
      "json",
    ]);
  });

  it("maps a kubectl execution failure the same way as getStatus", async () => {
    const { runner } = failingRunner({ code: 1, stderr: "connection refused" });
    await assert.rejects(getPodStates("app=nginx-voice", "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError);
      assert.equal(error.kind, "kubectl_failed");
      return true;
    });
  });
});

describe("scaleDeployment", () => {
  it("invokes kubectl with an exact argument array, never a shell string", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 6, "default", runner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]), "arguments must travel as an array");
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

  it("rejects invalid replicas before calling the runner", async () => {
    const { runner, calls } = fakeRunner({ stdout: "" });
    for (const replicas of [1.5, -1, NaN, Infinity, -0.5]) {
      await assert.rejects(scaleDeployment("nginx-voice", replicas, "default", runner), {
        name: "TypeError",
      });
    }
    assert.equal(calls.length, 0, "no invalid replicas may reach kubectl");
  });

  it("accepts 0 replicas (scales to zero)", async () => {
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

  it("maps NotFound to not_found also when scaling", async () => {
    const stderr = 'Error from server (NotFound): deployments.apps "nginx-voice" not found';
    const { runner } = failingRunner({ code: 1, stderr });
    await assert.rejects(scaleDeployment("nginx-voice", 6, "default", runner), (error: unknown) => {
      assert.ok(error instanceof KubectlError, "must throw a KubectlError");
      assert.equal(error.kind, "not_found");
      assert.equal(error.exitCode, 1);
      return true;
    });
  });
});

/**
 * External cluster selection: the `--kubeconfig`/`--context` flags are
 * appended at the end of the argument array (kubectl accepts its global
 * flags after the command arguments), as separate elements without a shell.
 * With no cluster configured, the argv stays exactly as before.
 */
describe("external cluster selection (--kubeconfig / --context)", () => {
  it("getStatus appends --kubeconfig at the end of the argv", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner, { kubeconfig: "/tmp/my-cluster.yaml" });
    assert.deepStrictEqual(calls[0], [
      "get",
      "deployment",
      "nginx-voice",
      "-n",
      "default",
      "-o",
      "json",
      "--kubeconfig",
      "/tmp/my-cluster.yaml",
    ]);
  });

  it("getPodStates appends --kubeconfig at the end of the argv", async () => {
    const { runner, calls } = fakeRunner({ stdout: podsJson([]) });
    await getPodStates("app=nginx-voice", "default", runner, { kubeconfig: "/tmp/my-cluster.yaml" });
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
      "/tmp/my-cluster.yaml",
    ]);
  });

  it("scaleDeployment appends --context at the end of the argv", async () => {
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

  it("with both set appends --kubeconfig then --context, in deterministic order", async () => {
    const { runner, calls } = fakeRunner({ stdout: "deployment.apps/nginx-voice scaled" });
    await scaleDeployment("nginx-voice", 3, "default", runner, {
      kubeconfig: "/tmp/my-cluster.yaml",
      context: "prod",
    });
    assert.deepStrictEqual(calls[0].slice(-4), [
      "--kubeconfig",
      "/tmp/my-cluster.yaml",
      "--context",
      "prod",
    ]);
  });

  it("getStatus with both set keeps the kubeconfig → context order", async () => {
    const { runner, calls } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runner, {
      kubeconfig: "/tmp/my-cluster.yaml",
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
      "/tmp/my-cluster.yaml",
      "--context",
      "prod",
    ]);
  });

  it("an empty cluster ({} or undefined) adds no flags", async () => {
    const { runner: runnerA, calls: callsA } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runnerA, {});
    assert.ok(!callsA[0].some((arg) => arg.startsWith("--kubeconfig") || arg.startsWith("--context")));

    const { runner: runnerB, calls: callsB } = fakeRunner({ stdout: DEPLOYMENT_JSON });
    await getStatus("nginx-voice", "default", runnerB, undefined);
    assert.ok(!callsB[0].some((arg) => arg.startsWith("--kubeconfig") || arg.startsWith("--context")));
  });
});