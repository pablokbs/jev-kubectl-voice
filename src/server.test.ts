/**
 * Tests of the HTTP server (`createVoiceServer`) with fake injected
 * classifier and kubectl runner: no real kubectl, no network beyond localhost.
 *
 * Each test starts a real server on 127.0.0.1:0 (ephemeral port) and talks to
 * it via `fetch`, closing it when done.
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

/** Test config: same deployment as the demo, no real effects. */
const TEST_CFG: ServerConfig = {
  port: 0,
  confidenceThreshold: 0.5,
  k8sDeployment: "nginx-voice",
  k8sNamespace: "default",
  k8sPodSelector: "app=nginx-voice",
  trafficReplicas,
  jevMock: true,
};

/** Fake classification with the given label at the given confidence. */
function classificationOf(choice: JevClassification["choice"], confidence: number): JevClassification {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

/** Passive wait of `ms` milliseconds (for slow fake classifiers). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Realistic `kubectl get deployment -o json` JSON for the fake runner. */
function deploymentJson(replicas: number, ready: number): string {
  return JSON.stringify({ kind: "Deployment", spec: { replicas }, status: { readyReplicas: ready } });
}

/** Fake classifier: records the calls and answers (or throws) as given. */
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
 * Fake kubectl runner, programmable per verb: the first `get` answers
 * `firstGet`, the second `secondGet` (or `firstGet` if not given); `scale`
 * answers `scale`. Error values are thrown as-is (execFile shape).
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
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { runner, calls };
}

/** Server booted on 127.0.0.1:0 with its port and graceful close. */
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
  assert.ok(address !== null && typeof address === "object", "must listen on an ephemeral port");
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

/** Boots, runs and always closes, even if the test fails. */
async function withServer(options: ServerOptions, run: (booted: Booted) => Promise<void>): Promise<void> {
  const booted = await boot(options);
  try {
    await run(booted);
  } finally {
    await booted.close();
  }
}

/** Standard test options with default injections. */
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

/** POST helper with a JSON body. */
function postCommand(base: string, body: string | undefined): Promise<Response> {
  return fetch(`${base}/api/voice-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}

/** Temp directory acting as `public/`, with optional files. */
async function makePublicDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-public-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

describe("POST /api/voice-command", () => {
  it("scales to the high level's replicas and confirms replicas before and after", async () => {
    const { classifier, calls: classifierCalls } = fakeClassifier(classificationOf("high", 0.92));
    const { runner, calls } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "we have heavy traffic" }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.transcript, "we have heavy traffic");
      assert.deepEqual(body.classification, {
        choice: "high",
        probabilities: { high: 0.92 },
        confidence: 0.92,
      });
      assert.deepEqual(body.action, {
        type: "scaled",
        replicas_before: 3,
        replicas_after: 10,
      });
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(body.timings.classify_ms >= 0);
      assert.deepEqual(classifierCalls, [{ text: "we have heavy traffic", currentReplicas: 3 }]);
      assert.deepEqual(
        calls.filter((args) => args[0] === "scale"),
        [["scale", "deployment", "nginx-voice", "-n", "default", "--replicas=10"]],
      );
    });
  });

  it("skips the adjustment with unsure and never calls kubectl scale", async () => {
    const { classifier } = fakeClassifier(classificationOf("unsure", 0.99));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 3) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "I'm not sure" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.deepEqual(body.action, {
        type: "skipped",
        replicas_before: 3,
        replicas_after: null,
        reason: body.action.reason,
      });
      assert.match(body.action.reason ?? "", /unsure/);
      assert.equal(body.classification.choice, "unsure");
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(body.timings.classify_ms >= 0);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("measures classify_ms with a slow classifier and total_ms >= classify_ms", async () => {
    const slow: Classifier = {
      async classify() {
        await sleep(100);
        return classificationOf("high", 0.92);
      },
    };
    const { runner } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier: slow, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "heavy traffic" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.classification.choice, "high");
      assert.ok(typeof body.timings.classify_ms === "number");
      assert.ok(
        body.timings.classify_ms >= 50,
        `classify_ms=${body.timings.classify_ms}, expected >= 50 (~100 ms classifier)`,
      );
      assert.ok(
        body.timings.total_ms >= body.timings.classify_ms,
        `total_ms=${body.timings.total_ms} must cover classify_ms=${body.timings.classify_ms}`,
      );
      assert.deepEqual(Object.keys(body), [
        "transcript",
        "classification",
        "action",
        "timings",
      ]);
    });
  });

  it("skips the adjustment when the confidence is below the threshold", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.3));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 3) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "heavy traffic" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "skipped");
      assert.match(body.action.reason ?? "", /below the threshold/);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("uses 0 replicas for the classifier and null as previous replicas when the initial get fails", async () => {
    const { classifier, calls: classifierCalls } = fakeClassifier(classificationOf("high", 0.92));
    const { runner } = fakeKubectl({
      firstGet: new Error("cluster down"),
      secondGet: deploymentJson(10, 10),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "heavy traffic" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.deepEqual(body.action, {
        type: "scaled",
        replicas_before: null,
        replicas_after: 10,
      });
      assert.deepEqual(classifierCalls, [{ text: "heavy traffic", currentReplicas: 0 }]);
    });
  });

  it("returns 200 with action.type 'error' when kubectl scale fails, keeping the classification", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.92));
    const { runner } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      scale: new KubectlError("kubectl_failed", "connection refused"),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "heavy traffic" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "error");
      assert.equal(body.action.replicas_before, 3);
      assert.equal(body.action.replicas_after, null);
      assert.match(body.action.reason ?? "", /Could not scale/);
      assert.match(body.action.reason ?? "", /connection refused/);
      assert.equal(body.classification.choice, "high");
      assert.equal(body.transcript, "heavy traffic");
    });
  });

  it("returns 200 with action.type 'error' when the state cannot be confirmed after scaling", async () => {
    const { classifier } = fakeClassifier(classificationOf("normal", 0.9));
    const { runner, calls } = fakeKubectl({
      firstGet: deploymentJson(3, 2),
      secondGet: new Error("get timed out"),
    });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "traffic normal" }));
      assert.equal(response.status, 200);
      const body = (await response.json()) as VoiceCommandResponse;
      assert.equal(body.action.type, "error");
      assert.equal(body.action.replicas_after, null);
      assert.match(body.action.reason ?? "", /could not be confirmed/);
      assert.equal(body.classification.choice, "normal");
      assert.equal(calls.some((args) => args[0] === "scale"), true, "the scale was indeed sent");
    });
  });

  it("returns 502 with an English error when the classifier fails, without scaling", async () => {
    const { classifier } = fakeClassifier(new Error("Jev is down"));
    const { runner, calls } = fakeKubectl({ firstGet: deploymentJson(3, 2) });
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "heavy traffic" }));
      assert.equal(response.status, 502);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /Could not classify/);
      assert.match(body.error, /Jev is down/);
      assert.equal(calls.some((args) => args[0] === "scale"), false);
    });
  });

  it("rejects an empty body with 400", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, undefined);
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.ok(body.error.length > 0, "the error must have a message in English");
    });
  });

  it("rejects with 400 when the text field is missing", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ other: 1 }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /text/);
    });
  });

  it("rejects with 400 when text is not a string", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: 42 }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /string/);
    });
  });

  it("rejects with 400 when text is empty", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "   " }));
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /cannot be empty/);
    });
  });

  it("rejects with 400 a body that is not valid JSON", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    await withServer(serverOptions({ classifier }), async ({ base }) => {
      const response = await postCommand(base, "this is not json");
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /JSON/);
    });
  });

  it("responds 413 when the body exceeds 10 KB, without touching kubectl", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const { runner, calls } = fakeKubectl({});
    await withServer(serverOptions({ classifier, kubectlRunner: runner }), async ({ base }) => {
      const response = await postCommand(base, JSON.stringify({ text: "a".repeat(11 * 1024) }));
      assert.equal(response.status, 413);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /10 KB/);
      assert.equal(calls.length, 0, "no kubectl call with an oversized body");
    });
  });
});

describe("GET /api/status", () => {
  it("returns the deployment state with the pod breakdown of the injected reader", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
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

  it("returns 503 with null replicas and zeroed pods when kubectl fails", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const { runner } = fakeKubectl({ firstGet: new KubectlError("kubectl_failed", "no cluster") });
    await withServer(
      serverOptions({
        classifier,
        kubectlRunner: runner,
        // Even if the pod reader has data, the deployment failure wins:
        // the 503 body shape must stay constant for the frontend.
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
        assert.match(body.error, /Could not query/);
        assert.match(body.error, /no cluster/);
      },
    );
  });

  it("returns 503 with zeroed pods when the pod reader fails", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const { runner } = fakeKubectl({ firstGet: deploymentJson(3, 2) });
    await withServer(
      serverOptions({
        classifier,
        kubectlRunner: runner,
        podStatesReader: async () => {
          throw new KubectlError("kubectl_failed", "broken pod list");
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

describe("routes and static files", () => {
  it("returns JSON 404 for unknown routes", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/api/unknown`);
        assert.equal(response.status, 404);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        const body = (await response.json()) as { error: string };
        assert.ok(body.error.length > 0);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("returns 404 with the wrong method on a known route", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
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

  it("serves a placeholder page at / when public/index.html does not exist", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        const html = await response.text();
        assert.match(html, /<!doctype html>/i);
        assert.match(html, /phase 2/, "the placeholder page mentions phase 2");
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("serves index.html, css and js from public/ with the correct content type", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir({
      "index.html": "<h1>hello from public</h1>",
      "style.css": "body { color: red; }",
      "app.js": "console.log('demo');",
    });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const home = await fetch(`${base}/`);
        assert.equal(home.status, 200);
        assert.equal(await home.text(), "<h1>hello from public</h1>");
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

  it("returns 404 for missing static files", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir();
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/missing.css`);
        assert.equal(response.status, 404);
        const body = (await response.json()) as { error: string };
        assert.ok(body.error.length > 0);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("returns 404 for extensions without a known content type", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir({ "notes.txt": "secret" });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        const response = await fetch(`${base}/notes.txt`);
        assert.equal(response.status, 404);
      });
    } finally {
      await fs.rm(publicDir, { recursive: true, force: true });
    }
  });

  it("blocks path traversal outside public/", async () => {
    const { classifier } = fakeClassifier(classificationOf("high", 0.9));
    const publicDir = await makePublicDir({ "index.html": "<h1>hi</h1>" });
    try {
      await withServer(serverOptions({ classifier, publicDir }), async ({ base }) => {
        // %2F encoded keeps the client from normalizing the dots: it reaches
        // the server as-is, which must reject it for leaving public/.
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