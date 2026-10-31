/**
 * Frontend of the "Voice → Jev → Kubernetes" demo (vanilla JS, zero dependencies).
 *
 * Flow:
 *  1. The operator speaks (webkitSpeechRecognition, en-US) or types a command.
 *  2. It is POSTed to /api/voice-command and the transcript is shown.
 *  3. "Jev's thinking" is drawn: probability bars + confidence.
 *  4. Every half second (500 ms) /api/status is polled to paint the pods
 *     (green running, orange starting, red terminating).
 *  5. Every action lands in the bottom log (last 5 events).
 */

/* ------------------------------------------------------------------ */
/* Minimal global state of the demo                                    */
/* ------------------------------------------------------------------ */

/** Browser speech recognition (Chrome: webkitSpeechRecognition). */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Traffic level in fixed order for the probability bars. */
const NIVELES = [
  { clave: "low", nombre: "low traffic" },
  { clave: "normal", nombre: "normal traffic" },
  { clave: "high", nombre: "high traffic" },
  { clave: "unsure", nombre: "not sure" },
];

/** Confidence threshold used by the backend policy (for the visual marker). */
const UMBRAL_CONFIANZA = 0.5;

/** /api/status polling interval in ms: half a second, to see the orange. */
const INTERVALO_SONDEO_MS = 500;

/** true while a POST /api/voice-command is in flight (anti double-send). */
let enviando = false;

/** true while the microphone is recording. */
let grabando = false;

/** Active speech recognition (or null). */
let reconocimiento = null;

/** Last painted (running,starting,terminating) signature: redraw only on change. */
let ultimaFirmaPods = null;

/** Accumulated final text of the transcript in progress. */
let transcripcionFinal = "";

/* ------------------------------------------------------------------ */
/* DOM shortcuts                                                       */
/* ------------------------------------------------------------------ */

const el = (id) => document.getElementById(id);

const ui = {
  pill: el("status-pill"),
  pillTexto: el("status-texto"),
  micro: el("mic-button"),
  microHint: el("mic-hint"),
  entrada: el("text-input"),
  enviar: el("send-button"),
  transcripcion: el("transcript"),
  pensamiento: el("thinking"),
  timing: el("jev-timing"),
  pods: el("pod-count"),
  podsSubline: el("pod-ready"),
  podsDeployment: el("pod-deployment"),
  log: el("action-log"),
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

/** Local HH:MM:SS time for the log. */
function horaActual() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

/** fetch + JSON guard: returns null when the response is not valid JSON. */
async function pedirJson(url, opciones) {
  try {
    const res = await fetch(url, opciones);
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, datos };
  } catch {
    // Network error: the polling loop must never break because of this.
    return { ok: false, status: 0, datos: null };
  }
}

/* ------------------------------------------------------------------ */
/* Transcript ("What I said")                                          */
/* ------------------------------------------------------------------ */

/** Paints the transcript: big final text + dimmer interim. */
function pintarTranscripcion(interino) {
  ui.transcripcion.replaceChildren();

  if (transcripcionFinal) {
    const final = document.createElement("span");
    final.textContent = transcripcionFinal;
    ui.transcripcion.appendChild(final);
  }

  if (interino) {
    const parcial = document.createElement("span");
    parcial.className = "interina";
    parcial.textContent = (transcripcionFinal ? " " : "") + interino;
    ui.transcripcion.appendChild(parcial);

    const cursor = document.createElement("span");
    cursor.className = "cursor-vivo";
    cursor.textContent = "▍";
    ui.transcripcion.appendChild(cursor);
  }

  if (!transcripcionFinal && !interino) {
    const vacio = document.createElement("span");
    vacio.className = "vacio";
    vacio.textContent = "you haven't said anything yet…";
    ui.transcripcion.appendChild(vacio);
  }
}

/* ------------------------------------------------------------------ */
/* Jev's thinking (probability bars + confidence)                      */
/* ------------------------------------------------------------------ */

/** Hides the timing line (new command in flight, error or missing data). */
function ocultarTiming() {
  ui.timing.hidden = true;
  ui.timing.textContent = "";
}

/** Shows "⚡ Jev decided in N ms" with the backend's classify_ms. */
function pintarTiming(timings) {
  const ms = timings && typeof timings.classify_ms === "number" && timings.classify_ms >= 0
    ? timings.classify_ms
    : null;
  if (ms === null) {
    ocultarTiming();
    return;
  }
  ui.timing.hidden = false;
  ui.timing.textContent = `⚡ Jev decided in ${ms} ms`;
}

/** "thinking…" state: subtle message while the POST is in flight. */
function pintarPensando() {
  ui.pensamiento.className = "pensamiento pensando";
  ui.pensamiento.replaceChildren();
  ocultarTiming();

  const msj = document.createElement("p");
  msj.className = "pensando-msj";
  msj.textContent = "thinking…";
  ui.pensamiento.appendChild(msj);
}

/** Draws a bar row for a traffic level. */
function crearBarra(clave, nombre, probabilidad, esGanadora) {
  const fila = document.createElement("div");
  fila.className = esGanadora ? "opcion ganadora" : "opcion";

  const etiqueta = document.createElement("span");
  etiqueta.className = "opcion-nombre";
  etiqueta.textContent = nombre;

  const pista = document.createElement("div");
  pista.className = "opcion-pista";

  const relleno = document.createElement("div");
  relleno.className = `opcion-relleno nivel-${clave}`;
  // CSS transition: starts at 0 and rises to the real value on the next frame.
  relleno.style.width = "0%";
  requestAnimationFrame(() => {
    relleno.style.width = `${Math.round(probabilidad * 100)}%`;
  });

  const porcentaje = document.createElement("span");
  porcentaje.className = "opcion-porcentaje";
  porcentaje.textContent = `${Math.round(probabilidad * 100)}%`;

  pista.appendChild(relleno);
  fila.append(etiqueta, pista, porcentaje);
  return fila;
}

/** Draws the confidence block: big percentage + bar with threshold marker. */
function crearConfianza(confidence) {
  const bloque = document.createElement("div");
  bloque.className = "confianza";

  const valor = document.createElement("span");
  const baja = confidence < UMBRAL_CONFIANZA;
  valor.className = baja ? "confianza-valor baja" : "confianza-valor";
  valor.textContent = `confidence: ${Math.round(confidence * 100)}%`;

  const pista = document.createElement("div");
  pista.className = "confianza-pista";

  const relleno = document.createElement("div");
  relleno.className = baja ? "confianza-relleno baja" : "confianza-relleno";
  relleno.style.width = "0%";
  requestAnimationFrame(() => {
    relleno.style.width = `${Math.round(confidence * 100)}%`;
  });

  const umbral = document.createElement("div");
  umbral.className = "confianza-umbral";
  umbral.title = `policy threshold: ${Math.round(UMBRAL_CONFIANZA * 100)}%`;

  const nota = document.createElement("span");
  nota.className = "confianza-nota";
  nota.textContent = "threshold 50%";

  pista.append(relleno, umbral, nota);
  bloque.append(valor, pista);
  return bloque;
}

/** Paints Jev's full classification (bars + winner + confidence). */
function pintarPensamiento(classification) {
  const probabilidades = classification?.probabilities ?? {};
  ui.pensamiento.className = "pensamiento";
  ui.pensamiento.replaceChildren();

  for (const { clave, nombre } of NIVELES) {
    const probabilidad = typeof probabilidades[clave] === "number" ? probabilidades[clave] : 0;
    ui.pensamiento.appendChild(crearBarra(clave, nombre, probabilidad, classification.choice === clave));
  }

  const confidence = typeof classification.confidence === "number" ? classification.confidence : 0;
  ui.pensamiento.appendChild(crearConfianza(confidence));
}

/* ------------------------------------------------------------------ */
/* Action log (last 5 events, newest first)                            */
/* ------------------------------------------------------------------ */

/** Adds an event to the log and re-renders it (max 5). */
function registrarAccion(texto, clase) {
  const item = document.createElement("li");

  const hora = document.createElement("span");
  hora.className = "log-hora";
  hora.textContent = horaActual();

  const msj = document.createElement("span");
  msj.className = clase;
  msj.textContent = texto;

  item.append(hora, msj);

  // Newest first, capped at 5 events.
  const vacio = ui.log.querySelector(".log-vacio");
  if (vacio) vacio.remove();
  ui.log.prepend(item);
  while (ui.log.children.length > 5) {
    ui.log.lastElementChild.remove();
  }
}

/** Translates the `action` part of the response into a log line. */
function registrarAction(action) {
  if (!action) return;
  const antes = action.replicas_before === null ? "—" : action.replicas_before;
  if (action.type === "scaled") {
    registrarAccion(`✅ scaled to ${action.replicas_after} replicas (was: ${antes})`, "log-escalado");
  } else if (action.type === "skipped") {
    registrarAccion(`⏭️ no action — ${action.reason || "command not understood"}`, "log-sin-accion");
  } else if (action.type === "error") {
    registrarAccion(`⚠️ error: ${action.reason || "unknown failure"}`, "log-error");
  }
}

/* ------------------------------------------------------------------ */
/* Sending commands                                                    */
/* ------------------------------------------------------------------ */

/** Enables/disables the controls while a send is in flight. */
function fijarControles(enVuelo) {
  ui.micro.disabled = enVuelo || !SR;
  ui.entrada.disabled = enVuelo;
  ui.enviar.disabled = enVuelo;
  ui.micro.classList.toggle("pensando", enVuelo);
}

/** POST /api/voice-command with an anti double-send guard and JSON guards. */
async function enviarComando(texto) {
  const limpio = texto.trim();
  if (!limpio || enviando) return;

  enviando = true;
  fijarControles(true);
  pintarPensando();

  const respuesta = await pedirJson("/api/voice-command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: limpio }),
  });

  const clasificacion = respuesta.datos?.classification;
  if (respuesta.ok && respuesta.datos && clasificacion) {
    pintarPensamiento(clasificacion);
    pintarTiming(respuesta.datos.timings);
    registrarAction(respuesta.datos.action);
  } else {
    ocultarTiming();
    const motivo = respuesta.datos?.error || "no response from the backend";
    registrarAccion(`⚠️ error: ${motivo}`, "log-error");
  }

  enviando = false;
  fijarControles(false);
}

/** Sends from the text field (button or Enter). */
function enviarDesdeTexto() {
  const texto = ui.entrada.value;
  ui.entrada.value = "";
  void enviarComando(texto);
}

/* ------------------------------------------------------------------ */
/* Microphone (webkitSpeechRecognition)                                */
/* ------------------------------------------------------------------ */

/** Configures the recognizer; browsers without support degrade to text. */
function configurarMicrofono() {
  if (!SR) {
    ui.micro.disabled = true;
    ui.micro.title = "your browser doesn't support speech recognition — use text instead";
    ui.microHint.textContent = "your browser doesn't support speech recognition — use text instead";
    ui.microHint.classList.add("alerta");
    return;
  }

  ui.micro.addEventListener("click", alAlternarMicrofono);
}

/** Toggles recording / stopping. */
function alAlternarMicrofono() {
  if (grabando) {
    reconocimiento.stop(); // onend closes the visual state.
    return;
  }
  iniciarEscucha();
}

/** Starts a new listening session (en-US, with interim results). */
function iniciarEscucha() {
  transcripcionFinal = "";
  pintarTranscripcion("");

  reconocimiento = new SR();
  reconocimiento.lang = "en-US";
  reconocimiento.interimResults = true;
  reconocimiento.continuous = false;

  reconocimiento.onresult = alResultadoVoz;
  reconocimiento.onerror = alErrorVoz;
  reconocimiento.onend = alFinEscucha;

  grabando = true;
  ui.micro.classList.add("grabando");
  ui.microHint.textContent = "recording… speak now (listening in en-US)";
  try {
    reconocimiento.start();
  } catch {
    // start() can fail if the browser rejects it (permissions, etc.).
    alFinEscucha();
  }
}

/** Dumps partial/final results into the "What I said" panel. */
function alResultadoVoz(evento) {
  let interino = "";
  for (let i = evento.resultIndex; i < evento.results.length; i += 1) {
    const alternativa = evento.results[i][0];
    if (evento.results[i].isFinal) {
      transcripcionFinal = (transcripcionFinal + " " + alternativa.transcript).trim();
    } else {
      interino += alternativa.transcript;
    }
  }
  pintarTranscripcion(interino.trim());

  // Final result available: send it immediately.
  if (transcripcionFinal && !enviando) {
    const texto = transcripcionFinal;
    transcripcionFinal = "";
    void enviarComando(texto);
  }
}

/** Recognizer errors (permissions, network, no speech…). */
function alErrorVoz(evento) {
  const mensajes = {
    "not-allowed": "microphone permission denied — use text instead",
    "service-not-allowed": "speech service blocked — use text instead",
    "no-speech": "I didn't hear anything — try again",
    network: "voice service network error",
  };
  ui.microHint.textContent = mensajes[evento.error] || `voice error: ${evento.error}`;
  ui.microHint.classList.add("alerta");
}

/** Closes the recording visual state. */
function alFinEscucha() {
  grabando = false;
  ui.micro.classList.remove("grabando");
  if (!enviando) {
    ui.microHint.textContent = "Press the mic and speak.";
    ui.microHint.classList.remove("alerta");
  }
  pintarTranscripcion("");
}

/* ------------------------------------------------------------------ */
/* Pod counter (polls /api/status every 500 ms)                        */
/* ------------------------------------------------------------------ */

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
    const { deployment, replicas, ready_replicas: listos, pods } = respuesta.datos;
    if (typeof deployment === "string" && deployment) {
      ui.podsDeployment.textContent = deployment;
    }
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

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/** Entry point: wires up events and starts the periodic polling. */
function iniciar() {
  configurarMicrofono();
  fijarControles(false);

  ui.enviar.addEventListener("click", enviarDesdeTexto);
  ui.entrada.addEventListener("keydown", (tecla) => {
    if (tecla.key === "Enter") {
      tecla.preventDefault();
      enviarDesdeTexto();
    }
  });

  pintarTranscripcion("");
  void consultarEstado();
  setInterval(() => void consultarEstado(), INTERVALO_SONDEO_MS);
}

iniciar();