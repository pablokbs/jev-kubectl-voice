/**
 * Tests de los assets de la demo: anti-spoiler de public/ y readiness del manifest.
 *
 * La charla en vivo depende de dos invariantes:
 *  1. Las frases del guion ("Pone todo lo que tenemos en el cluster", "Ya está
 *     todo normal") NO aparecen en los archivos servidos al público (public/):
 *     la pantalla proyectada no puede revelar el guion. El README sí las cita
 *     a propósito (es el documento del orador).
 *  2. El deployment trae un delay artificial de readiness chico (~1s) con
 *     sondeo cada 1s, y el frontend sondea /api/status cada 500ms: los
 *     cuadraditos naranjas de "arrancando" siguen viéndose en el escenario.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

const leerAsset = (rutaRelativa: string): string =>
  readFileSync(join(RAIZ, rutaRelativa), "utf8");

/** Frases del guion que no deben filtrarse en la UI proyectada. */
const FRASES_DEL_GUION = [
  "Pone todo lo que tenemos en el cluster",
  "pone todo lo que tenemos en el cluster",
  "Ya está todo normal",
  "ya está todo normal",
  "todo lo que tenemos",
];

describe("anti-spoiler de public/", () => {
  const archivos = ["public/index.html", "public/app.js"];

  for (const archivo of archivos) {
    it(`"${archivo}" no menciona ninguna frase del guion`, () => {
      const contenido = leerAsset(archivo);
      for (const frase of FRASES_DEL_GUION) {
        assert.ok(
          !contenido.includes(frase),
          `"${archivo}" filtra la frase del guion: "${frase}"`,
        );
      }
    });
  }

  it("index.html usa el hint neutral del micrófono y no tiene footer de ejemplos", () => {
    const html = leerAsset("public/index.html");
    assert.ok(html.includes("Pulsá el micro y hablá."), "falta el hint neutral");
    assert.ok(!html.includes("Frases de ejemplo"), "el footer de ejemplos sigue presente");
  });

  it("app.js restablece el mismo hint neutral al terminar la escucha", () => {
    const js = leerAsset("public/app.js");
    assert.ok(
      js.includes('ui.microHint.textContent = "Pulsá el micro y hablá.";'),
      "alFinEscucha no restablece el hint neutral",
    );
  });

  it("app.js usa createElement/textContent y nunca innerHTML", () => {
    const js = leerAsset("public/app.js");
    assert.ok(js.includes("document.createElement"), "app.js no usa createElement");
    assert.ok(js.includes(".textContent"), "app.js no usa textContent");
    assert.ok(!js.includes("innerHTML"), "app.js usa innerHTML");
  });
});

describe("timing de la decisión de Jev en pantalla", () => {
  it("index.html tiene el elemento #jev-timing en el panel del pensamiento", () => {
    const html = leerAsset("public/index.html");
    assert.ok(html.includes('id="jev-timing"'), "falta el elemento #jev-timing");
    assert.ok(html.includes('class="jev-timing"'), "el elemento #jev-timing no tiene su clase");
  });

  it("app.js pinta 'decidió en N ms' y oculta la línea al pensar y al fallar", () => {
    const js = leerAsset("public/app.js");
    assert.ok(js.includes('el("jev-timing")'), "app.js no engancha #jev-timing");
    assert.ok(js.includes("decidió en"), "app.js no muestra cuánto tardó Jev");
    assert.ok(js.includes("ocultarTiming"), "app.js no oculta la línea de timing");
    assert.ok(js.includes("pintarTiming(respuesta.datos.timings)"), "app.js no pinta el timing con la respuesta");
  });

  it("style.css tiene el estilo sutil de la línea de timing", () => {
    const css = leerAsset("public/style.css");
    assert.ok(css.includes(".jev-timing"), "falta el estilo .jev-timing");
  });
});

describe("cadencia de sondeo del frontend", () => {
  it("app.js sondea /api/status cada 500 ms", () => {
    const js = leerAsset("public/app.js");
    const constante = js.match(/const INTERVALO_SONDEO_MS = (\d+);/);
    assert.ok(constante, "no está la constante INTERVALO_SONDEO_MS");
    assert.equal(constante[1], "500");
    assert.ok(
      js.includes("setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);"),
      "el sondeo no usa INTERVALO_SONDEO_MS",
    );
    assert.ok(!js.includes("2000"), "quedó un intervalo viejo de 2000 ms");
  });
});

describe("pantalla de pods para el segmento de Hermes", () => {
  it("pods.html existe con la cuadrícula #pod-count, la leyenda y el caption de listos", () => {
    const html = leerAsset("public/pods.html");
    assert.ok(html.includes('id="pod-count"'), "falta la cuadrícula #pod-count");
    assert.ok(html.includes('id="pod-ready"'), "falta el caption #pod-ready");
    for (const etiqueta of ["corriendo", "arrancando", "muriendo"]) {
      assert.ok(html.includes(etiqueta), `falta la etiqueta de leyenda "${etiqueta}"`);
    }
  });

  it("pods.html enlaza /style.css y carga /pods.js como script plano con defer", () => {
    const html = leerAsset("public/pods.html");
    assert.ok(html.includes('href="/style.css"'), "no enlaza /style.css");
    assert.ok(
      html.includes('<script src="/pods.js" defer></script>'),
      "pods.js no se carga como script plano con defer",
    );
  });

  it("pods.html no tiene micrófono, transcripción, pensamiento ni registro", () => {
    const html = leerAsset("public/pods.html");
    for (const id of ["transcript", "thinking", "mic-button", "text-input", "send-button", "action-log"]) {
      assert.ok(!html.includes(`id="${id}"`), `aparece el id prohibido "${id}"`);
    }
  });

  it("pods.html no filtra frases del guion y no menciona al asistente de la demo", () => {
    const html = leerAsset("public/pods.html");
    for (const frase of FRASES_DEL_GUION) {
      assert.ok(
        !html.toLowerCase().includes(frase.toLowerCase()),
        `"public/pods.html" filtra la frase del guion: "${frase}"`,
      );
    }
    assert.ok(!/jev/i.test(html), '"public/pods.html" menciona al asistente de la demo');
  });

  it("pods.js sondea /api/status cada 500 ms", () => {
    const js = leerAsset("public/pods.js");
    const constante = js.match(/const INTERVALO_SONDEO_MS = (\d+);/);
    assert.ok(constante, "no está la constante INTERVALO_SONDEO_MS en pods.js");
    assert.equal(constante[1], "500");
    assert.ok(
      js.includes("setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);"),
      "el sondeo de pods.js no usa INTERVALO_SONDEO_MS",
    );
  });

  it("pods.js construye el DOM con createElement/textContent y sin innerHTML", () => {
    const js = leerAsset("public/pods.js");
    assert.ok(js.includes("document.createElement"), "pods.js no usa createElement");
    assert.ok(js.includes(".textContent"), "pods.js no usa textContent");
    assert.ok(!js.includes("innerHTML"), "pods.js usa innerHTML");
  });

  it("pods.js pinta en orden running→starting→terminating y cachea la firma", () => {
    const js = leerAsset("public/pods.js");
    const iRunning = js.indexOf("pod-square--running");
    const iStarting = js.indexOf("pod-square--starting");
    const iTerminating = js.indexOf("pod-square--terminating");
    assert.ok(
      iRunning !== -1 && iRunning < iStarting && iStarting < iTerminating,
      "los grupos de cuadraditos no están en el orden running→starting→terminating",
    );
    assert.ok(js.includes("ultimaFirmaPods"), "no cachea la firma de pods");
  });
});

describe("readiness del manifest k8s/deployment.yaml", () => {
  it("initialDelaySeconds ~1s con sondeo periodSeconds 1s", () => {
    const yaml = leerAsset("k8s/deployment.yaml");
    assert.match(yaml, /initialDelaySeconds:\s*1\b/, "initialDelaySeconds no es 1");
    assert.match(yaml, /periodSeconds:\s*1\b/, "falta periodSeconds: 1");
    assert.ok(!yaml.match(/initialDelaySeconds:\s*3\b/), "sigue el delay viejo de 3s");
  });
});
