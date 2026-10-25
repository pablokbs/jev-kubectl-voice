# Plan: Demo Voz Jev K8s
---

## Goal
  Construir una mini demo para charla donde el hablante habla al navegador (Web Speech API),
  un backend Node+TS clasifica el texto con el modelo Jev (TypeSafe AI) vía pregunta `choice`
  sobre nivel de tráfico, escala un deployment nginx en el cluster Kubernetes local con
  `kubectl scale`, y una página web muestra en vivo la transcripción, el "pensamiento" de Jev
  (probabilidades por opción + confianza) y la cantidad actual de pods.

--- INTENT CHARTER ---
Intent (the user's original request, verbatim): Vamos a crear una mini demo con jev y kubernetes para una demo de una charla. La idea es usar jev y el capturador de voz del navegador para hacerle preguntas rapidas y controlar un cluster de kubernetes. El cluster va a tener un set de pods de nginx que van a escalar por medio de kubectl. Jev va a analizar mis pedidos como "tenemos mucho trafico" para crear mas pods y "el trafico es normal" para disminuir la cantidad de pods. Esto se va a mostrar por medio de una interfaz web que va a mostrar el pensamiento de jev, la transcripción de mi voz y el estado de la cantidad de pods.
Wow factor (what would delight, not merely satisfy): La audiencia ve en una sola pantalla y en vivo: el hablante habla en español → la transcripción aparece → las barras de probabilidad de Jev "piensan" → los pods de nginx escalan físicamente en el cluster; un loop voz→IA→Kubernetes completo y visible en menos de 3 segundos.
Confirmed scope (in / explicitly out): En scope: backend Node+TS que clasifica texto con Jev (API oficial TypeSafe) y ejecuta kubectl scale sobre un deployment nginx del cluster local del usuario; frontend de una página con micrófono (Web Speech API), transcripción, probabilidades de Jev y contador de pods; manifest k8s, modo mock JEV_MOCK=1 para ensayo/verificación, README con guion. Fuera de scope: setup de cluster (el usuario ya tiene uno), streaming de audio al backend (la transcripción se hace en el navegador), autenticación/multiusuario, deploy a producción — es una demo local para una charla.
Acceptance demo (beats the final walkthrough must show): 1) Abrir localhost:3000 en Chrome con el cluster corriendo y el deployment nginx-voice en 3 réplicas visibles en el contador grande de la UI. 2) Apretar el micrófono y decir "tenemos mucho tráfico": aparece la transcripción, las barras del pensamiento de Jev marcan "alto" con probabilidad alta, y el contador de pods escala a 6 mientras kubectl scale actúa en vivo. 3) Decir "el tráfico es normal": la UI muestra la clasificación "normal" y los pods vuelven a 3. 4) Mostrar el modo ensayo (JEV_MOCK=1) como red de seguridad si falla la red o la API durante la charla.
Grade against this charter — it records the user's original intent. The plan and criteria below are a refinement of it; where they read narrower than the intent, the intent wins unless the charter's confirmed scope says otherwise.

## Success criteria
  - Backend clasificador: `npm run dev` levanta un servidor Node+TS (Node 22+) con `POST
    /api/voice-command` que recibe texto, lo clasifica con Jev (choice sobre nivel de
    tráfico vía @typesafe-ai/sdk, TYPESAFE_API_KEY del entorno) y devuelve JSON con opción
    ganadora, probabilidades y confianza. Verificación: curl POST con "tenemos mucho
    tráfico" devuelve choice=alto con probabilidades.
  - Ejecución kubectl: si la confianza supera el umbral configurable, el backend ejecuta
    `kubectl scale` del deployment nginx según mapeo nivel→réplicas; con frases ambiguas o
    confianza baja NO ejecuta y lo reporta. Verificación: `npm test` con SDK mockeado + POST
    en vivo cambia el replicas real observado con `kubectl get deployment nginx-voice`.
  - Estado del cluster: `GET /api/status` devuelve las réplicas actuales del deployment
    leyendo kubectl. Verificación: el número coincide con `kubectl get deployment
    nginx-voice -o jsonpath='{.spec.replicas}'`.
  - Frontend de demo: página única servida por el backend con botón de micrófono (Web Speech
    API en español, Chrome/Edge en localhost) que muestra en vivo transcripción,
    “pensamiento de jev” (barras de probabilidad + confianza) y cantidad actual de pods.
    Verificación: walkthrough manual documentado + el HTML/JS se sirve correctamente (curl a
    /).
  - Reproducibilidad: el repo incluye k8s/deployment.yaml (nginx-voice, baseline 3
    réplicas), .env.example y README con pasos de la demo. Verificación: `kubectl apply
    --dry-run=client -f k8s/` sin errores.
  - Tests: `npm test` verde cubriendo mapeo nivel→réplicas, gateo por umbral de confianza y
    parseo de salida de kubectl, con el SDK de Jev mockeado (sin llamadas reales a la API en
    tests).

## Constraints
  - Node.js 22+ con TypeScript; única dependencia runtime: @typesafe-ai/sdk (0.7.x); tooling
    dev: typescript + tsx + @types/node; sin framework web (node:http nativo alcanza para 2
    endpoints + estáticos).
  - TYPESAFE_API_KEY se lee solo de variable de entorno; jamás hardcodeada ni commiteada
    (.env en .gitignore, .env.example documentado).
  - kubectl se invoca con execFile y arrays de argumentos (sin shell, sin interpolación del
    texto del usuario) contra el contexto kubeconfig actual; deployment `nginx-voice` en
    namespace default, nombre configurable por env K8S_DEPLOYMENT.
  - Los tests unitarios NUNCA llaman a la API real de Jev ni a un cluster real (SDK y
    executor inyectados/mockeados).
  - Modo mock `JEV_MOCK=1`: clasificador determinista por palabras clave que permite
    verificación automatizada y ensayo de la charla sin API key.
  - Web Speech API requiere Chrome/Edge y localhost; el frontend incluye input de texto como
    fallback por si el micrófono falla en vivo.

## Assumptions
  - Asumo que el cluster local del usuario está accesible vía el contexto actual de kubectl
    al momento de la demo y de correr el E2E. Decisiones tomadas (reversibles,
    documentadas): mapeo fijo nivel→réplicas {bajo:1, normal:3, alto:6} en vez de
    incrementos relativos — hace la demo predecible y cumple las dos frases del guion
    ("mucho tráfico" sube a 6, "tráfico normal" baja de 6 a 3)
  - la pregunta `choice` incluye una 4ta opción `no_se` para frases no relacionadas, y un
    umbral de confianza por defecto 0.5 (ambos configurables) para no ejecutar kubectl con
    input ambiguo
  - "el pensamiento de jev" se muestra como la distribución de probabilidades por opción +
    confianza, porque Jev no genera texto/chain-of-thought
  - actualización del contador de pods por polling cada 2s en vez de WebSocket/SSE (menos
    partes móviles en una demo)
  - servidor con node:http sin Express para minimizar dependencias
  - reconocimiento de voz en es-ES
  - el modo mock JEV_MOCK=1 clasifica por palabras clave ("mucho"/"alto"→alto,
    "normal"→normal, "poco"/"bajo"→bajo) para verificación determinística y ensayo sin
    gastar API
  - se incluye el manifest k8s aunque el usuario ya tenga cluster, para que la demo sea
    reproducible por cualquiera que clone el repo.

## Scope decisions (vs the literal request)
- “El pensamiento de jev” se implementa como barras de probabilidad por opción + confianza, porque Jev (System One) no genera texto ni chain-of-thought.
- “Crear más pods / disminuir” se implementa como mapeo absoluto nivel→réplicas (1/3/6) en vez de incrementos relativos: efecto visible idéntico con comportamiento predecible en vivo.
- Se agrega un modo mock (JEV_MOCK=1) no pedido explícitamente, como red de seguridad para ensayar la charla y para verificación determinística sin gastar API.

## Constraint costs
- Modo mock JEV_MOCK=1 con clasificador por palabras clave — costs: En modo mock la clasificación no proviene del modelo Jev real — sirve para ensayo y CI, no demuestra el modelo.
- Sin framework web (node:http nativo) — costs: Ruteo y parseo de body escritos a mano; no escala a más endpoints, pero la demo solo tiene dos.
- Web Speech API requiere Chrome/Edge y localhost — costs: La demo de voz no funciona en Firefox/Safari; hay fallback de texto tipeado para esos casos.

## Quality dimensions
- Legibilidad de la UI en un proyector (fuente grande, alto contraste, contador de pods dominante) — dueño: paso 1 de la fase 2; el walkthrough manual lo valida.
- Coherencia de la narrativa de la demo (frases del guion ↔ opciones del choice ↔ mapeo de réplicas ↔ ejemplos del README) — dueño transversal: revisar en el cierre de la fase 2.
- Robustez en vivo: fallos de micrófono, red o API no deben dejar la demo colgada (fallback de texto, modo mock, timeouts en la llamada a Jev) — dueños: pasos 4 (fase 1) y 1 (fase 2).

## Self-critique (meh-test)
Dimensiones del pedido no verificables automáticamente: (1) la precisión del reconocimiento de voz en vivo (ruido de sala, acento) — brecha deliberada, mitigada con el input de texto como fallback; (2) el aspecto visual de la UI — importa en un escenario; no hay chequeo automático, lo cubre el walkthrough manual del paso 4 de la fase 2 y quality_dimensions; (3) la latencia real de la API de Jev desde la red del venue — mitigada por el modo mock como plan B. El "pensamiento de jev" del pedido se interpreta como distribución de probabilidades (Jev no produce texto razonado); si el usuario imaginaba otra cosa (p.ej. explicación en lenguaje natural), sería un scope delta a revisar, pero la interpretación elegida es la única que el modelo soporta.

## Phases
---

### Phase 1: Backend: voz → Jev → kubectl
**Goal:** Servidor Node+TS funcional que clasifica texto con Jev (o mock), escala el deployment
          nginx vía kubectl con gateo por confianza, y expone /api/voice-command y /api/status,
          con tests unitarios verdes sin llamadas reales.
**Steps:**
- Scaffold del proyecto: package.json con scripts (dev/start con tsx, test con node
  --test + tsx), tsconfig.json (ESM, strict), .gitignore (node_modules, .env),
  .env.example documentando TYPESAFE_API_KEY y K8S_DEPLOYMENT, y src/config.ts que
  centraliza lectura de env (umbral de confianza default 0.5, mapeo nivel→réplicas
  {bajo:1, normal:3, alto:6}, nombre del deployment nginx-voice, puerto 3000).
- Clasificador Jev + política: src/jev.ts con cliente inyectable que llama
  client.systemOne({state: {comando_operador, replicas_actuales}, questions: {trafico:
  choice('Nivel de tráfico según el operador', {bajo, normal, alto, no_se})}}}) y
  devuelve {choice, probabilities, confidence}; src/policy.ts con
  decideAction(clasificación, config) → {type:'scale', replicas} | {type:'skip',
  reason} (skip si choice=no_se o confidence < umbral); src/mock-jev.ts clasificador
  determinista por palabras clave para JEV_MOCK=1. Tests: src/jev.test.ts con SDK
  mockeado (frases en español → opción esperada) y src/policy.test.ts tabla de casos
  (umbral, no_se, mapeo de réplicas).
- Wrapper kubectl: src/kubectl.ts con scaleDeployment(name, replicas) y
  getReplicas(name) usando node:child_process execFile con array de args, parseo de
  `kubectl get deployment -o json`, errores tipados (deployment inexistente, kubectl
  no disponible). Tests src/kubectl.test.ts con executor inyectado falso: parseo de
  JSON, propagación de errores, y verificación de que los args se pasan como array sin
  interpolación de shell.
- Servidor HTTP (node:http, sin framework) src/server.ts: sirve /public como
  estáticos; POST /api/voice-command {text} → {transcript,
  classification:{choice,probabilities,confidence}, action:{type:'scaled'|'skipped',
  replicas_before?, replicas_after?, reason?}}; GET /api/status → {deployment,
  replicas, ready_replicas}; selección de clasificador real/mock vía JEV_MOCK.

### Phase 2: Frontend + assets de demo
**Goal:** Página web de una sola vista que consume el backend de la fase 1 (micrófono con Web
          Speech API, transcripción, pensamiento de Jev, contador de pods en vivo), más manifest
          de Kubernetes, script E2E en modo mock y README con el guion de la charla.
**Steps:**
- Frontend public/index.html + public/app.js + public/style.css: botón de micrófono
  con webkitSpeechRecognition (lang es-ES, interim results), input de texto + botón
  como fallback, panel de transcripción, panel 'pensamiento de jev' con barras de
  probabilidad por opción y confianza, contador grande de pods que pollea GET
  /api/status cada 2s, y log de acciones (scaled/skipped + razón). Contrato: POST
  /api/voice-command {text} y GET /api/status de la fase 1.
- Manifest k8s/deployment.yaml: Deployment nginx-voice (imagen nginx:alpine, replicas:
  3, labels app=nginx-voice, resources mínimos) con comentarios pensados para mostrar
  en la charla.
- Script scripts/e2e-mock.sh: aplica el manifest, espera rollout, levanta el server
  con JEV_MOCK=1, curl POST "tenemos mucho tráfico" y assert de replicas=6 vía kubectl
  jsonpath, curl POST "el tráfico es normal" y assert de replicas=3, cleanup (volver a
  3 y matar server). Ejecutarlo contra el cluster local del usuario.
- README.md con: arquitectura (diagrama ASCII voz→browser→server→Jev→kubectl), setup
  (TYPESAFE_API_KEY, aplicar manifest, npm install && npm run dev, abrir
  localhost:3000 en Chrome), guion de la charla con las frases de ejemplo, modo ensayo
  JEV_MOCK=1 sin API key, y troubleshooting (micrófono, contexto de kubectl, latencia
  de la API). Luego walkthrough manual en vivo: con la API key real, decir "tenemos
  mucho tráfico" y "el tráfico es normal" por el micrófono y observar en la UI la
  transcripción, las barras de probabilidad y el cambio de pods (evidencia
  inspeccionada, no automatizable).

---