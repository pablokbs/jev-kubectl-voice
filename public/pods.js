/**
 * Secondary squares screen: only the state of the cluster's pods.
 * No microphone or transcript: it polls /api/status every 500 ms and paints.
 * Deliberately standalone: it does not import app.js (zero coupling).
 */

/** /api/status polling interval in ms: half a second, like the main page. */
const INTERVALO_SONDEO_MS = 500;

/** DOM shortcuts. */
const el = (id) => document.getElementById(id);

const ui = {
  pill: el("status-pill"),
  pillTexto: el("status-texto"),
  pods: el("pod-count"),
  podsSubline: el("pod-ready"),
};

/** Last painted (running,starting,terminating) signature: redraw only on change. */
let ultimaFirmaPods = null;

/** fetch + JSON guard: returns null when the response is not valid JSON. */
async function pedirJson(url) {
  try {
    const res = await fetch(url);
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, datos };
  } catch {
    // Network error: the polling loop must never break because of this.
    return { ok: false, status: 0, datos: null };
  }
}

/** Paints the connection state in the header pill. */
function pintarPill(estado, mensaje) {
  ui.pill.className = `pill pill-${estado}`;
  ui.pillTexto.textContent = mensaje;
}

/**
 * Paints the pods as squares inside #pod-count, in order
 * running → starting → terminating. Only redraws when the signature
 * (running,starting,terminating) changes: identical polls don't touch the DOM.
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

/** Shows the "—" placeholder in #pod-count (backend or network failure). */
function pintarPodsVacios() {
  if (ultimaFirmaPods === null && ui.pods.querySelector(".pods-vacio")) return;
  ultimaFirmaPods = null;
  ui.pods.replaceChildren();
  const vacio = document.createElement("span");
  vacio.className = "pods-vacio";
  vacio.textContent = "—";
  ui.pods.appendChild(vacio);
}

/** One polling cycle: 200 → squares; 503/network → "—" + red pill. */
async function consultarEstado() {
  const respuesta = await pedirJson("/api/status");

  if (respuesta.ok && respuesta.datos && typeof respuesta.datos.replicas === "number") {
    const { replicas, ready_replicas: listos, pods } = respuesta.datos;
    pintarPods(pods);
    ui.podsSubline.textContent = `${listos ?? 0}/${replicas} ready`;
    ui.podsSubline.classList.remove("sin-datos");
    pintarPill("ok", "backend + cluster OK");
  } else {
    const motivo = respuesta.datos?.error || "no backend connection";
    pintarPodsVacios();
    ui.podsSubline.textContent = "no cluster data";
    ui.podsSubline.classList.add("sin-datos");
    pintarPill("error", motivo);
  }
}

void consultarEstado();
setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);