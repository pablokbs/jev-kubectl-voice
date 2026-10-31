/**
 * Tests of the demo assets: public/ anti-spoiler and manifest readiness.
 *
 * The live talk depends on two invariants:
 *  1. The script phrases ("Put everything we have into the cluster",
 *     "Everything is back to normal") must NOT appear in the files served to
 *     the audience (public/): the projected screen cannot reveal the script.
 *     The README does quote them on purpose (it is the speaker's document).
 *  2. The deployment has a small artificial readiness delay (~1s) with 1s
 *     probing, and the frontend polls /api/status every 500ms: the orange
 *     "starting" squares remain visible on stage.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const readAsset = (relativePath: string): string =>
  readFileSync(join(ROOT, relativePath), "utf8");

/** Script phrases that must not leak into the projected UI. */
const SCRIPT_PHRASES = [
  "Put everything we have into the cluster",
  "put everything we have into the cluster",
  "Everything is back to normal",
  "everything is back to normal",
  "everything we have",
];

describe("public/ anti-spoiler", () => {
  const files = ["public/index.html", "public/app.js"];

  for (const file of files) {
    it(`"${file}" does not mention any script phrase`, () => {
      const content = readAsset(file);
      for (const phrase of SCRIPT_PHRASES) {
        assert.ok(
          !content.includes(phrase),
          `"${file}" leaks the script phrase: "${phrase}"`,
        );
      }
    });
  }

  it("index.html uses the neutral mic hint and has no examples footer", () => {
    const html = readAsset("public/index.html");
    assert.ok(html.includes("Press the mic and speak."), "the neutral hint is missing");
    assert.ok(!html.includes("Frases de ejemplo"), "the examples footer is still present");
  });

  it("app.js restores the same neutral hint when the listening session ends", () => {
    const js = readAsset("public/app.js");
    assert.ok(
      js.includes('ui.microHint.textContent = "Press the mic and speak.";'),
      "alFinEscucha does not restore the neutral hint",
    );
  });

  it("app.js uses createElement/textContent and never innerHTML", () => {
    const js = readAsset("public/app.js");
    assert.ok(js.includes("document.createElement"), "app.js does not use createElement");
    assert.ok(js.includes(".textContent"), "app.js does not use textContent");
    assert.ok(!js.includes("innerHTML"), "app.js uses innerHTML");
  });
});

describe("Jev's decision timing on screen", () => {
  it("index.html has the #jev-timing element in the thinking panel", () => {
    const html = readAsset("public/index.html");
    assert.ok(html.includes('id="jev-timing"'), "the #jev-timing element is missing");
    assert.ok(html.includes('class="jev-timing"'), "the #jev-timing element has no class");
  });

  it("app.js paints 'decided in N ms' and hides the line while thinking and on failure", () => {
    const js = readAsset("public/app.js");
    assert.ok(js.includes('el("jev-timing")'), "app.js does not hook #jev-timing");
    assert.ok(js.includes("decided in"), "app.js does not show how long Jev took");
    assert.ok(js.includes("ocultarTiming"), "app.js does not hide the timing line");
    assert.ok(js.includes("pintarTiming(respuesta.datos.timings)"), "app.js does not paint the timing from the response");
  });

  it("style.css has the subtle timing line style", () => {
    const css = readAsset("public/style.css");
    assert.ok(css.includes(".jev-timing"), "the .jev-timing style is missing");
  });
});

describe("frontend polling cadence", () => {
  it("app.js polls /api/status every 500 ms", () => {
    const js = readAsset("public/app.js");
    const constant = js.match(/const INTERVALO_SONDEO_MS = (\d+);/);
    assert.ok(constant, "the INTERVALO_SONDEO_MS constant is missing");
    assert.equal(constant[1], "500");
    assert.ok(
      js.includes("setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);"),
      "the polling does not use INTERVALO_SONDEO_MS",
    );
    assert.ok(!js.includes("2000"), "an old 2000 ms interval is still around");
  });
});

describe("pod screen for the Hermes segment", () => {
  it("pods.html exists with the #pod-count grid, the legend and the ready caption", () => {
    const html = readAsset("public/pods.html");
    assert.ok(html.includes('id="pod-count"'), "the #pod-count grid is missing");
    assert.ok(html.includes('id="pod-ready"'), "the #pod-ready caption is missing");
    for (const label of ["running", "starting", "terminating"]) {
      assert.ok(html.includes(label), `the legend label "${label}" is missing`);
    }
  });

  it("pods.html links /style.css and loads /pods.js as a plain defer script", () => {
    const html = readAsset("public/pods.html");
    assert.ok(html.includes('href="/style.css"'), "does not link /style.css");
    assert.ok(
      html.includes('<script src="/pods.js" defer></script>'),
      "pods.js is not loaded as a plain defer script",
    );
  });

  it("pods.html has no microphone, transcript, thinking or log", () => {
    const html = readAsset("public/pods.html");
    for (const id of ["transcript", "thinking", "mic-button", "text-input", "send-button", "action-log"]) {
      assert.ok(!html.includes(`id="${id}"`), `the forbidden id "${id}" appears`);
    }
  });

  it("pods.html does not leak script phrases and does not mention the demo assistant", () => {
    const html = readAsset("public/pods.html");
    for (const phrase of SCRIPT_PHRASES) {
      assert.ok(
        !html.toLowerCase().includes(phrase.toLowerCase()),
        `"public/pods.html" leaks the script phrase: "${phrase}"`,
      );
    }
    assert.ok(!/jev/i.test(html), '"public/pods.html" mentions the demo assistant');
  });

  it("pods.js polls /api/status every 500 ms", () => {
    const js = readAsset("public/pods.js");
    const constant = js.match(/const INTERVALO_SONDEO_MS = (\d+);/);
    assert.ok(constant, "the INTERVALO_SONDEO_MS constant is missing in pods.js");
    assert.equal(constant[1], "500");
    assert.ok(
      js.includes("setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);"),
      "pods.js polling does not use INTERVALO_SONDEO_MS",
    );
  });

  it("pods.js builds the DOM with createElement/textContent and without innerHTML", () => {
    const js = readAsset("public/pods.js");
    assert.ok(js.includes("document.createElement"), "pods.js does not use createElement");
    assert.ok(js.includes(".textContent"), "pods.js does not use textContent");
    assert.ok(!js.includes("innerHTML"), "pods.js uses innerHTML");
  });

  it("pods.js paints in running→starting→terminating order and caches the signature", () => {
    const js = readAsset("public/pods.js");
    const iRunning = js.indexOf("pod-square--running");
    const iStarting = js.indexOf("pod-square--starting");
    const iTerminating = js.indexOf("pod-square--terminating");
    assert.ok(
      iRunning !== -1 && iRunning < iStarting && iStarting < iTerminating,
      "the square groups are not in running→starting→terminating order",
    );
    assert.ok(js.includes("ultimaFirmaPods"), "the pod signature is not cached");
  });
});

describe("readiness of the k8s/deployment.yaml manifest", () => {
  it("initialDelaySeconds ~1s with periodSeconds 1s probing", () => {
    const yaml = readAsset("k8s/deployment.yaml");
    assert.match(yaml, /initialDelaySeconds:\s*1\b/, "initialDelaySeconds is not 1");
    assert.match(yaml, /periodSeconds:\s*1\b/, "periodSeconds: 1 is missing");
    assert.ok(!yaml.match(/initialDelaySeconds:\s*3\b/), "the old 3s delay is still around");
  });
});