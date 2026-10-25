/**
 * Frontend de la demo "Voz → Jev → Kubernetes" (vanilla JS, cero dependencias).
 *
 * Flujo:
 *  1. El operador habla (webkitSpeechRecognition, es-ES) o escribe un comando.
 *  2. Se envía por POST a /api/voice-command y se muestra la transcripción.
 *  3. Se dibuja "el pensamiento de Jev": barras de probabilidad + confianza.
 *  4. Cada medio segundo (500 ms) se consulta /api/status para pintar los pods
 *     (verde corriendo, naranja arrancando, rojo terminando).
 *  5. Cada acción queda en el registro inferior (últimos 5 eventos).
 */

/* ------------------------------------------------------------------ */
/* Estado global mínimo de la demo                                     */
/* ------------------------------------------------------------------ */

/** Reconocimiento de voz del navegador (Chrome: webkitSpeechRecognition). */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Nivel de tráfico en orden fijo para las barras de probabilidad. */
const NIVELES = [
  { clave: "bajo", nombre: "tráfico bajo" },
  { clave: "normal", nombre: "tráfico normal" },
  { clave: "alto", nombre: "tráfico alto" },
  { clave: "no_se", nombre: "no lo sé" },
];

/** Umbral de confianza que usa la política del backend (para la marca visual). */
const UMBRAL_CONFIANZA = 0.5;

/** Intervalo de sondeo de /api/status en ms: medio segundo, para ver el naranja. */
const INTERVALO_SONDEO_MS = 500;

/** true mientras hay un POST /api/voice-command en vuelo (anti doble envío). */
let enviando = false;

/** true mientras el micrófono está grabando. */
let grabando = false;

/** Reconocimiento de voz activo (o null). */
let reconocimiento = null;

/** Última firma (running,starting,terminating) pintada: solo se redibuja si cambia. */
let ultimaFirmaPods = null;

/** Texto final acumulado de la transcripción en curso. */
let transcripcionFinal = "";

/* ------------------------------------------------------------------ */
/* Atajos de DOM                                                       */
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
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Hora local HH:MM:SS para el registro. */
function horaActual() {
  return new Date().toLocaleTimeString("es-ES", { hour12: false });
}

/** fetch + guarda de JSON: devuelve null si la respuesta no es JSON válido. */
async function pedirJson(url, opciones) {
  try {
    const res = await fetch(url, opciones);
    const datos = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, datos };
  } catch {
    // Error de red: el bucle de sondeo nunca debe romperse por esto.
    return { ok: false, status: 0, datos: null };
  }
}

/* ------------------------------------------------------------------ */
/* Transcripción ("Lo que dije")                                       */
/* ------------------------------------------------------------------ */

/** Pinta la transcripción: texto final grande + interino más tenue. */
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
    vacio.textContent = "todavía no dijiste nada…";
    ui.transcripcion.appendChild(vacio);
  }
}

/* ------------------------------------------------------------------ */
/* Pensamiento de Jev (barras de probabilidad + confianza)             */
/* ------------------------------------------------------------------ */

/** Oculta la línea de timing (nuevo comando en vuelo, error o dato ausente). */
function ocultarTiming() {
  ui.timing.hidden = true;
  ui.timing.textContent = "";
}

/** Muestra "⚡ Jev decidió en N ms" con el classify_ms del backend. */
function pintarTiming(timings) {
  const ms = timings && typeof timings.classify_ms === "number" && timings.classify_ms >= 0
    ? timings.classify_ms
    : null;
  if (ms === null) {
    ocultarTiming();
    return;
  }
  ui.timing.hidden = false;
  ui.timing.textContent = `⚡ Jev decidió en ${ms} ms`;
}

/** Estado "pensando…": mensaje sutil mientras el POST está en vuelo. */
function pintarPensando() {
  ui.pensamiento.className = "pensamiento pensando";
  ui.pensamiento.replaceChildren();
  ocultarTiming();

  const msj = document.createElement("p");
  msj.className = "pensando-msj";
  msj.textContent = "pensando…";
  ui.pensamiento.appendChild(msj);
}

/** Dibuja una fila de barra para un nivel de tráfico. */
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
  // Transición CSS: arranca en 0 y sube al valor real en el próximo frame.
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

/** Dibuja el bloque de confianza: porcentaje grande + barra con umbral. */
function crearConfianza(confidence) {
  const bloque = document.createElement("div");
  bloque.className = "confianza";

  const valor = document.createElement("span");
  const baja = confidence < UMBRAL_CONFIANZA;
  valor.className = baja ? "confianza-valor baja" : "confianza-valor";
  valor.textContent = `confianza: ${Math.round(confidence * 100)}%`;

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
  umbral.title = `umbral de la política: ${Math.round(UMBRAL_CONFIANZA * 100)}%`;

  const nota = document.createElement("span");
  nota.className = "confianza-nota";
  nota.textContent = "umbral 50%";

  pista.append(relleno, umbral, nota);
  bloque.append(valor, pista);
  return bloque;
}

/** Pinta la clasificación completa de Jev (barras + ganadora + confianza). */
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
/* Registro de acciones (últimos 5 eventos, el más nuevo primero)      */
/* ------------------------------------------------------------------ */

/** Agrega un evento al registro y lo re-renderiza (máximo 5). */
function registrarAccion(texto, clase) {
  const item = document.createElement("li");

  const hora = document.createElement("span");
  hora.className = "log-hora";
  hora.textContent = horaActual();

  const msj = document.createElement("span");
  msj.className = clase;
  msj.textContent = texto;

  item.append(hora, msj);

  // El más nuevo primero, tope de 5 eventos.
  const vacio = ui.log.querySelector(".log-vacio");
  if (vacio) vacio.remove();
  ui.log.prepend(item);
  while (ui.log.children.length > 5) {
    ui.log.lastElementChild.remove();
  }
}

/** Traduce la parte `action` de la respuesta a una línea del registro. */
function registrarAction(action) {
  if (!action) return;
  const antes = action.replicas_before === null ? "—" : action.replicas_before;
  if (action.type === "scaled") {
    registrarAccion(`✅ escalado a ${action.replicas_after} réplicas (antes: ${antes})`, "log-escalado");
  } else if (action.type === "skipped") {
    registrarAccion(`⏭️ sin acción — ${action.reason || "no entendí el comando"}`, "log-sin-accion");
  } else if (action.type === "error") {
    registrarAccion(`⚠️ error: ${action.reason || "fallo desconocido"}`, "log-error");
  }
}

/* ------------------------------------------------------------------ */
/* Envío de comandos                                                   */
/* ------------------------------------------------------------------ */

/** Habilita/deshabilita los controles según haya un envío en vuelo. */
function fijarControles(enVuelo) {
  ui.micro.disabled = enVuelo || !SR;
  ui.entrada.disabled = enVuelo;
  ui.enviar.disabled = enVuelo;
  ui.micro.classList.toggle("pensando", enVuelo);
}

/** POST /api/voice-command con guarda anti doble envío y guards de JSON. */
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
    const motivo = respuesta.datos?.error || "no hubo respuesta del backend";
    registrarAccion(`⚠️ error: ${motivo}`, "log-error");
  }

  enviando = false;
  fijarControles(false);
}

/** Envío desde el campo de texto (botón o Enter). */
function enviarDesdeTexto() {
  const texto = ui.entrada.value;
  ui.entrada.value = "";
  void enviarComando(texto);
}

/* ------------------------------------------------------------------ */
/* Micrófono (webkitSpeechRecognition)                                 */
/* ------------------------------------------------------------------ */

/** Configura el reconocedor; si el navegador no lo soporta, degrada a texto. */
function configurarMicrofono() {
  if (!SR) {
    ui.micro.disabled = true;
    ui.micro.title = "tu navegador no soporta reconocimiento de voz — usá el texto";
    ui.microHint.textContent = "tu navegador no soporta reconocimiento de voz — usá el texto";
    ui.microHint.classList.add("alerta");
    return;
  }

  ui.micro.addEventListener("click", alAlternarMicrofono);
}

/** Alterna grabar / detener. */
function alAlternarMicrofono() {
  if (grabando) {
    reconocimiento.stop(); // onend se encarga de cerrar el estado visual.
    return;
  }
  iniciarEscucha();
}

/** Arranca una nueva escucha (es-ES, con resultados interinos). */
function iniciarEscucha() {
  transcripcionFinal = "";
  pintarTranscripcion("");

  reconocimiento = new SR();
  reconocimiento.lang = "es-ES";
  reconocimiento.interimResults = true;
  reconocimiento.continuous = false;

  reconocimiento.onresult = alResultadoVoz;
  reconocimiento.onerror = alErrorVoz;
  reconocimiento.onend = alFinEscucha;

  grabando = true;
  ui.micro.classList.add("grabando");
  ui.microHint.textContent = "grabando… hablá ahora (te escucho en es-ES)";
  try {
    reconocimiento.start();
  } catch {
    // start() puede fallar si el navegador lo rechaza (permisos, etc.).
    alFinEscucha();
  }
}

/** Vuelca resultados parciales/finales al panel "Lo que dije". */
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

  // Resultado final disponible: se envía de inmediato.
  if (transcripcionFinal && !enviando) {
    const texto = transcripcionFinal;
    transcripcionFinal = "";
    void enviarComando(texto);
  }
}

/** Errores del reconocedor (permisos, red, sin habla…). */
function alErrorVoz(evento) {
  const mensajes = {
    "not-allowed": "permiso de micrófono denegado — usá el texto",
    "service-not-allowed": "servicio de voz bloqueado — usá el texto",
    "no-speech": "no escuché nada — probá de nuevo",
    network: "error de red del servicio de voz",
  };
  ui.microHint.textContent = mensajes[evento.error] || `error de voz: ${evento.error}`;
  ui.microHint.classList.add("alerta");
}

/** Cierra el estado visual de grabación. */
function alFinEscucha() {
  grabando = false;
  ui.micro.classList.remove("grabando");
  if (!enviando) {
    ui.microHint.textContent = "Pulsá el micro y hablá.";
    ui.microHint.classList.remove("alerta");
  }
  pintarTranscripcion("");
}

/* ------------------------------------------------------------------ */
/* Contador de pods (sondeo /api/status cada 500 ms)                   */
/* ------------------------------------------------------------------ */

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
    const { deployment, replicas, ready_replicas: listos, pods } = respuesta.datos;
    if (typeof deployment === "string" && deployment) {
      ui.podsDeployment.textContent = deployment;
    }
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

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

/** Punto de entrada: cablea eventos y lanza el sondeo periódico. */
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
