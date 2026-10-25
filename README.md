# Voz → Jev → Kubernetes

Demo de conferencia (5 minutos, en vivo): hablas en español, **Jev** (TypeSafe AI) clasifica el nivel de tráfico de tu frase, y esa decisión **escala en vivo un deployment de nginx en Kubernetes** con `kubectl scale`. Sin frameworks en el backend, sin dependencias en el frontend: todo corre en tu portátil, sobre un cluster local.

**Qué verás en pantalla** (`http://localhost:3000` en Chrome):

- Un botón grande de micrófono y, debajo, **"Lo que dije"**: la transcripción en vivo de tu voz.
- **"El pensamiento de Jev"**: barras de probabilidad por nivel (`bajo` / `normal` / `alto` / `no_se`) y la confianza de la decisión.
- Un **panel de cuadraditos de pods** (sondea el cluster cada medio segundo): un cuadrado por pod, verde = corriendo, naranja = arrancando, rojo = muriendo — ves nacer y morir los pods al escalar de 3 a 10.
- Una pill de estado en la cabecera ("backend + cluster OK") y un registro de las últimas acciones.

## Arquitectura

```
                voz en español (es-ES)
                        │
                        ▼
 ┌───────────────────────────────────────────────┐
 │ Navegador (Chrome/Edge) en localhost:3000     │
 │ Web Speech API: voz → transcripción           │
 │ (public/index.html · public/app.js)           │
 └──────────────────┬────────────────────────────┘
                    │ POST /api/voice-command {"text": "..."}
                    ▼
 ┌───────────────────────────────────────────────┐
 │ Servidor Node 22 + TypeScript, node:http      │
 │ (src/server.ts)                               │
 │   1. estado actual     → src/kubectl.ts       │
 │   2. clasificar frase  → src/jev.ts  ───────┐ │
 │   3. decidir acción    → src/policy.ts      │ │
 │   4. kubectl scale     → src/kubectl.ts     │ │
 │   (src/config.ts: entorno + réplicas)       │ │
 └──────────────────────┬──────────────────────┼─┘
                        │                      ▼
                        │            ┌──────────────────────┐
                        │            │ Jev · TypeSafe AI    │
                        │            │ pregunta `choice`:   │
                        │            │ bajo/normal/alto/    │
                        │            │ no_se (@typesafe-ai/ │
                        │            │ sdk, /v1/answer)     │
                        │            └──────────────────────┘
                        ▼
 ┌───────────────────────────────────────────────┐
 │ Cluster local (kubeconfig, contexto actual)   │
 │ Deployment nginx-voice (k8s/deployment.yaml)  │
 │ réplicas objetivo: bajo:1 · normal:3 · alto:10 │
 └───────────────────────────────────────────────┘
```

La política (`src/policy.ts`) es conservadora a propósito: si Jev responde `no_se`, o la confianza queda por debajo de `CONFIDENCE_THRESHOLD`, **no se toca nada** (`action.type: "skipped"`).

## Requisitos

- **Node 22 o superior** (`node --version`).
- **Chrome o Edge**: la Web Speech API del micrófono solo existe ahí, y funciona desde `localhost` sin HTTPS.
- **kubectl apuntando a un cluster local** (rancher-desktop, kind o minikube): `kubectl get ns` debe responder.
- Una **cuenta en typesafe.ai** para obtener la `TYPESAFE_API_KEY` (solo para el modo real; el modo ensayo no la necesita).

## Puesta en marcha

Desde la raíz del repo:

1. **Instala las dependencias** (una sola vez):

   ```bash
   npm install
   ```

2. **Configura el entorno**: copia la plantilla y exporta tu clave de TypeSafe AI en el shell (el servidor lee solo variables de entorno; `npm run dev` **no** carga `.env` automáticamente):

   ```bash
   cp .env.example .env   # plantilla con todas las variables documentadas
   set -a; source .env; set +a   # exporta el contenido del .env
   export TYPESAFE_API_KEY="tu-clave-de-typesafe.ai"
   ```

   Sin clave exportada el servidor no arranca (error claro en español), salvo que uses el modo ensayo `JEV_MOCK=1` (ver más abajo).

3. **Aplica el deployment de la demo** en el cluster del contexto actual:

   ```bash
   kubectl apply -f k8s/deployment.yaml
   ```

4. **Arranca el servidor**:

   ```bash
   npm run dev
   ```

5. **Abre `http://localhost:3000` en Chrome** y permite el micrófono cuando el navegador lo pida. La pill de la cabecera debe pasar a "backend + cluster OK".

## Guion de la charla (5 min)

La narrativa arranca con un **clip de película de superhéroes**: el héroe, bajo presión, le ordena a su IA **"poné todo lo que tenemos en los propulsores"**. Tesis: ese tipo de orden cruda, sin contexto ni cortesías, es justamente lo que una IA que divaga o tarda no sabe responder — y en producción hay que decidir al instante. Jev responde una pregunta tipada con probabilidades al toque, y esa decisión escala cómputo real.

Checklist escénico, en orden:

- [ ] **Terminal 1**: `npm run dev` (con `TYPESAFE_API_KEY` exportada). Terminal 2 al lado: `kubectl get pods -l app=nginx-voice -w` — verás los pods nacer en vivo.
- [ ] **Segmento inicial con Hermes**: abre `http://localhost:3000/pods.html` — muestra solo los cuadraditos de pods (sin Jev) para la parte inicial con Hermes, la pantalla que la audiencia ve mientras la otra IA maneja el cluster.
- [ ] **Arranque**: muestra el clip del héroe y su IA, cuenta la tesis, y muestra el cluster con sus **3 pods** y la pill verde de la web. Pilla el micrófono.
- [ ] **Subida**: di **"Pone todo lo que tenemos en el cluster"**. Señala en orden: la transcripción en "Lo que dije" → las barras del pensamiento de Jev → la confianza → la línea ⚡ **Jev decidió en N ms** (el número para comparar con el modelo lento del segmento inicial) → los **cuadraditos pasando de 3 a 10** (aparecen naranjas mientras arrancan y se ponen verdes al estar listos; el manifest trae un delay artificial de readiness de ~1s y la UI sondea cada 500ms, así el naranja sigue viéndose en el escenario); en la otra ventana, los pods nuevos en `Running`.
- [ ] **Bajada**: di **"Ya está todo normal"**. Los cuadraditos vuelven a **3**: siete se ponen rojos un instante (muriendo) y desaparecen.
- [ ] *(Si sobra tiempo)* di algo irrelevante ("hoy es martes"): Jev duda, la política lo descarta y **no escala nada**.
- [ ] **Remate**: *"Mi voz acabó de escalar cuánto cómputo hay corriendo."*

## Modo ensayo (`JEV_MOCK=1`)

Para ensayar sin API key (ni wifi del venue confiable):

```bash
JEV_MOCK=1 npm run dev
```

Jev se sustituye por un clasificador **offline y determinista** por palabras clave (`src/mock-jev.ts`). Cada keyword se matchea como **inicio de palabra** (left-anchored word boundary: `\b<keyword>`), así que los prefijos siguen funcionando ("saturad" matchea "saturadísimo") pero las colisiones de substrings no ("inestable" no matchea "estable"). Listas (evaluadas en este orden):

- `alto`: "mucho/alto/saturad/pico/todo lo que/propulsor/toda la potencia/potencia maxima/maximo"
- `normal`: "normal/habitual/estable/tranqui/ya esta"
- `bajo`: "poc/bajo/nada/sin" (el tallo "poc" cubre poco/poca/pocos/pocas)
- cualquier otra cosa → `no_se` (se descarta). En particular "tenemos poca potencia disponible" cae en `bajo` (la keyword "potencia" sola se quitó de `alto` a propósito) y "el servicio está inestable" cae en `no_se`. Mismo flujo, mismos pods, cero red.

Antes de subir al escenario, un smoke test completo del sistema (aplica el manifest, espera el rollout, escala con la orden del héroe a 10, vuelve a 3 con "ya está todo normal", comprueba que un comando irrelevante no escala, y deja todo en 3 réplicas):

```bash
bash scripts/e2e-mock.sh
```

## Configuración

Todas las variables se leen del entorno (`src/config.ts`); ninguna es obligatoria salvo `TYPESAFE_API_KEY` en modo real.

| Variable              | Default       | Para qué                                                                 |
| --------------------- | ------------- | ------------------------------------------------------------------------ |
| `TYPESAFE_API_KEY`    | *(vacía)*     | Clave de la API de TypeSafe AI. Obligatoria salvo con `JEV_MOCK=1`.       |
| `JEV_MOCK`            | *(vacía)*     | `1` = clasificador offline determinista, sin red ni clave de API.         |
| `K8S_DEPLOYMENT`      | `nginx-voice` | Nombre del deployment a escalar.                                          |
| `K8S_NAMESPACE`       | `default`     | Namespace del deployment.                                                 |
| `K8S_POD_SELECTOR`    | `app=nginx-voice` | Selector de pods para el desglose de estados de los cuadraditos.            |
| `K8S_KUBECONFIG`      | *(vacía)*     | Ruta a un kubeconfig de un cluster externo (flag `--kubeconfig`).         |
| `K8S_CONTEXT`         | *(vacía)*     | Contexto a usar dentro del kubeconfig (flag `--context`).                 |
| `CONFIDENCE_THRESHOLD`| `0.5`         | Confianza mínima de Jev: por debajo, no se escala (se omite).             |
| `PORT`                | `3000`        | Puerto HTTP del servidor.                                                 |

## Apuntar a un cluster externo

Por defecto el backend habla con el cluster del contexto actual de kubectl.
Para apuntar a un cluster externo sin tocar `~/.kube/config`:

1. Copia el kubeconfig del cluster objetivo a un archivo (p. ej.
   `./externo.kubeconfig`; el patrón `*.kubeconfig` está en `.gitignore`, no
   lo commitees) y pon `K8S_KUBECONFIG=./externo.kubeconfig` en tu `.env`.
2. Si el cluster ya está en tu kubeconfig actual, basta con
   `K8S_CONTEXT=nombre` (lista los contextos con `kubectl config get-contexts`).
3. Recarga el entorno y reinicia el servidor:

   ```bash
   set -a; source .env; set +a
   npm run dev
   ```

Ambas páginas (`/` y `/pods.html`) pasan a mostrar el cluster externo. Con
ambas variables vacías el comportamiento es el de siempre (contexto por
defecto de kubectl).

kubectl también honra su propia variable `KUBECONFIG` (fusión de varios
archivos); si está puesta, el flag explícito de `K8S_KUBECONFIG` gana.

## API

| Método | Ruta                   | Qué hace                                                                 |
| ------ | ---------------------- | ------------------------------------------------------------------------ |
| POST   | `/api/voice-command`   | Clasifica `{"text": "..."}` con Jev y escala (o no) el deployment.        |
| GET    | `/api/status`          | Estado actual del deployment y desglose de pods (lo que usa el panel de cuadraditos).            |

Escalar a 10 réplicas con la orden del héroe:

```bash
curl -s -X POST http://localhost:3000/api/voice-command \
  -H 'Content-Type: application/json' \
  -d '{"text":"pone todo lo que tenemos en el cluster"}'
```

```json
{
  "transcript": "pone todo lo que tenemos en el cluster",
  "classification": {
    "choice": "alto",
    "probabilities": { "alto": 0.92, "normal": 0.05, "bajo": 0.02, "no_se": 0.01 },
    "confidence": 0.92
  },
  "action": { "type": "scaled", "replicas_before": 3, "replicas_after": 10 },
  "timings": { "classify_ms": 842, "total_ms": 1431 }
}
```

`timings` mide en ms (enteros) cuánto tardó Jev en clasificar (`classify_ms`) y cuánto tardó el flujo completo (`total_ms`); el frontend lo muestra junto a la confianza.

`action.type` es `scaled`, `skipped` (frase dudosa o confianza baja) o `error` (kubectl falló a mitad del flujo).

Estado actual:

```bash
curl -s http://localhost:3000/api/status
```

```json
{
  "deployment": "nginx-voice",
  "replicas": 3,
  "ready_replicas": 3,
  "pods": { "running": 3, "starting": 0, "terminating": 0 }
}
```

Errores: `400` cuerpo vacío o no JSON, `413` cuerpo > 10 KB, `502` con `{"error": ...}` si Jev no pudo clasificar, `503` en `/api/status` si kubectl falla. Nunca un 500 por culpa de Jev o kubectl.

## Solución de problemas

- **El micrófono no funciona**: usa Chrome o Edge (`webkitSpeechRecognition` no existe en Firefox/Safari) y accede por `http://localhost:3000`; revisa también los permisos de micrófono del sistema operativo y del navegador.
- **Plan B sin voz**: escribe el comando en el campo de texto de la UI ("…o escribí el comando acá") y pulsa Enviar; recorre exactamente el mismo flujo.
- **kubectl con el contexto equivocado**: mira `kubectl config current-context` y cambia con `kubectl config use-context <contexto>`; el backend usa el contexto actual del kubeconfig.
- **"El deployment no existe"** (o el panel de pods en `—`): aplica el manifest de la demo con `kubectl apply -f k8s/deployment.yaml` y comprueba con `kubectl get deployment nginx-voice`.
- **La API de Jev tarda o falla** (502 en el registro): ensaya con `JEV_MOCK=1`, donde no hay red en el camino de clasificación.
- **¿Está todo roto?** Ejecuta los tests: `npm test` (además `npm run typecheck`). Los tests **nunca llaman a la API real** ni a un cluster.

## Estructura del repo

```
jev-kubectl-voice/
├── package.json          # scripts npm (dev, start, test, typecheck) y dependencias
├── .env.example          # plantilla de variables de entorno (copiar a .env)
├── tsconfig.json         # configuración de TypeScript
├── src/
│   ├── server.ts         # servidor HTTP: rutas /api/*, estáticos de public/, flujo voz
│   ├── config.ts         # variables de entorno tipadas + réplicas por nivel de tráfico
│   ├── jev.ts            # clasificador Jev real (TypeSafe AI, pregunta choice) y fábrica
│   ├── mock-jev.ts       # clasificador mock determinista por palabras clave
│   ├── policy.ts         # política pura: clasificación → escalar u omitir
│   ├── kubectl.ts        # envoltorio de kubectl (get/scale) sin shell, errores tipados
│   └── *.test.ts         # tests con node:test (no tocan la API real ni el cluster)
├── public/
│   ├── index.html        # UI: micrófono, transcripción, pensamiento de Jev, cuadraditos de pods
│   ├── app.js            # Web Speech API + polling de /api/status + envío de comandos
│   ├── pods.html         # pantalla solo-cuadraditos para el segmento inicial con Hermes (sin Jev)
│   ├── pods.js           # sondeo propio de /api/status cada 500 ms, independiente de app.js
│   └── style.css         # estilos, todo local (la wifi del venue no se puede confiar)
├── k8s/
│   └── deployment.yaml   # deployment nginx-voice (nginx:alpine, base de 3 réplicas)
└── scripts/
    └── e2e-mock.sh       # smoke test end-to-end completo en modo mock
```
