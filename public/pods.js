/**
 * Pantalla secundaria de cuadraditos: solo el estado de los pods del cluster.
 * Sin micrófono ni transcripción: sondea /api/status cada 500 ms y pinta.
 * Archivo independiente a propósito: no importa app.js (cero acoplamiento).
 */

/** Intervalo de sondeo de /api/status en ms: medio segundo, como la página principal. */
const INTERVALO_SONDEO_MS = 500;

/** Atajos de DOM. */
const el = (id) => document.getElementById(id);

const ui = {
  pill: el("status-pill"),
  pillTexto: el("status-texto"),
  pods: el("pod-count"),
  podsSubline: el("pod-ready"),
};

/** Última firma (running,starting,terminating) pintada: solo se redibuja si cambia. */
let ultimaFirmaPods = null;

/** fetch + guarda de JSON: devuelve null si la respuesta no es JSON válido. */
async function pedirJson(url) {
  try {
    const res = await fetch(url);
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, datos };
  } catch {
    // Error de red: el bucle de sondeo nunca debe romperse por esto.
    return { ok: false, status: 0, datos: null };
  }
}

/** Pinta el estado de conexión en la pill de la cabecera. */
function pintarPill(estado, mensaje) {
  ui.pill.className = `pill pill-${estado}`;
  ui.pillTexto.textContent = mensaje;
}

/**
 * Pinta los pods como cuadraditos dentro de #pod-count, en orden
 * running → starting → terminating. Solo redibuja cuando la firma
 * (running,starting,terminating) cambia: los sondeos idénticos no tocan el DOM.
 */
function pintarPods(pods) {
  const running = typeof pods?.running === "number" && pods.running >= 0 ? pods.running : 0;
  const starting = typeof pods?.starting === "number" && pods.starting >= 0 ? pods.starting : 0;
  const terminating =
    typeof pods?.terminating === "number" && pods.terminating >= 0 ? pods.terminating : 0;

  const firma = `${running}:${starting}:${terminating}`;
  if (firma === ultimaFirmaPods) return;
  ultimaFirmaPods = firma;

  ui.pods.replaceChildren();
  const grupos = [
    { cantidad: running, clase: "pod-square--running" },
    { cantidad: starting, clase: "pod-square--starting" },
    { cantidad: terminating, clase: "pod-square--terminating" },
  ];
  for (const { cantidad, clase } of grupos) {
    for (let i = 0; i < cantidad; i += 1) {
      const cuadro = document.createElement("div");
      cuadro.className = `pod-square ${clase}`;
      ui.pods.appendChild(cuadro);
    }
  }
}

/** Muestra el placeholder "—" en #pod-count (fallo de backend o de red). */
function pintarPodsVacios() {
  if (ultimaFirmaPods === null && ui.pods.querySelector(".pods-vacio")) return;
  ultimaFirmaPods = null;
  ui.pods.replaceChildren();
  const vacio = document.createElement("span");
  vacio.className = "pods-vacio";
  vacio.textContent = "—";
  ui.pods.appendChild(vacio);
}

/** Un ciclo de sondeo: 200 → cuadraditos; 503/red → "—" + pill roja. */
async function consultarEstado() {
  const respuesta = await pedirJson("/api/status");

  if (respuesta.ok && respuesta.datos && typeof respuesta.datos.replicas === "number") {
    const { replicas, ready_replicas: listos, pods } = respuesta.datos;
    pintarPods(pods);
    ui.podsSubline.textContent = `${listos ?? 0}/${replicas} listos`;
    ui.podsSubline.classList.remove("sin-datos");
    pintarPill("ok", "backend + cluster OK");
  } else {
    const motivo = respuesta.datos?.error || "sin conexión con el backend";
    pintarPodsVacios();
    ui.podsSubline.textContent = "sin datos del cluster";
    ui.podsSubline.classList.add("sin-datos");
    pintarPill("error", motivo);
  }
}

void consultarEstado();
setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);
