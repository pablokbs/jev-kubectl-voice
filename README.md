# Voice → Jev → Kubernetes

Conference demo (5 minutes, live): you speak in English, **Jev** (TypeSafe AI) classifies the traffic level of your sentence, and that decision **live-scales an nginx deployment in Kubernetes** with `kubectl scale`. No frameworks on the backend, no dependencies on the frontend: everything runs on your laptop, on a local cluster.

**What you'll see on screen** (`http://localhost:3000` in Chrome):

- A big microphone button and, below it, **"What I said"**: the live transcript of your voice.
- **"Jev's thinking"**: probability bars per level (`low` / `normal` / `high` / `unsure`) and the confidence of the decision.
- A **panel of pod squares** (polls the cluster every half second): one square per pod, green = running, orange = starting, red = dying — you watch pods being born and dying as you scale from 3 to 10.
- A status pill in the header ("backend + cluster OK") and a log of the most recent actions.

## Architecture

```
                English voice (en-US)
                        │
                        ▼
 ┌───────────────────────────────────────────────┐
 │ Browser (Chrome/Edge) at localhost:3000       │
 │ Web Speech API: voice → transcript            │
 │ (public/index.html · public/app.js)           │
 └──────────────────┬────────────────────────────┘
                    │ POST /api/voice-command {"text": "..."}
                    ▼
 ┌───────────────────────────────────────────────┐
 │ Node 22 + TypeScript server, node:http        │
 │ (src/server.ts)                               │
 │   1. current state     → src/kubectl.ts       │
 │   2. classify phrase   → src/jev.ts  ───────┐ │
 │   3. decide action     → src/policy.ts      │ │
 │   4. kubectl scale     → src/kubectl.ts     │ │
 │   (src/config.ts: env + replicas)           │ │
 └──────────────────────┬──────────────────────┼─┘
                        │                      ▼
                        │            ┌──────────────────────┐
                        │            │ Jev · TypeSafe AI    │
                        │            │ asks a `choice`:     │
                        │            │ low/normal/high/     │
                        │            │ unsure (@typesafe-ai/│
                        │            │ sdk, /v1/answer)     │
                        │            └──────────────────────┘
                        ▼
 ┌───────────────────────────────────────────────┐
 │ Local cluster (kubeconfig, current context)   │
 │ nginx-voice deployment (k8s/deployment.yaml)  │
 │ target replicas: low:1 · normal:3 · high:10   │
 └───────────────────────────────────────────────┘
```

The policy (`src/policy.ts`) is conservative on purpose: if Jev answers `unsure`, or the confidence falls below `CONFIDENCE_THRESHOLD`, **nothing is touched** (`action.type: "skipped"`).

## Requirements

- **Node 22 or newer** (`node --version`).
- **Chrome or Edge**: the Web Speech microphone API only exists there, and it works from `localhost` without HTTPS.
- **kubectl pointing at a local cluster** (rancher-desktop, kind or minikube): `kubectl get ns` must respond.
- A **typesafe.ai account** to get the `TYPESAFE_API_KEY` (only for real mode; mock mode does not need it).

## Setup

From the repo root:

1. **Install the dependencies** (once):

   ```bash
   npm install
   ```

2. **Configure the environment**: copy the template and export your TypeSafe AI key in the shell (the server only reads environment variables; `npm run dev` does **not** load `.env` automatically):

   ```bash
   cp .env.example .env   # template with every variable documented
   set -a; source .env; set +a   # exports the .env contents
   export TYPESAFE_API_KEY="your-typesafe.ai-key"
   ```

   Without an exported key the server does not start (clear error), unless you use mock mode with `JEV_MOCK=1` (see below).

3. **Apply the demo deployment** to the current context's cluster:

   ```bash
   kubectl apply -f k8s/deployment.yaml
   ```

4. **Start the server**:

   ```bash
   npm run dev
   ```

5. **Open `http://localhost:3000` in Chrome** and allow the microphone when the browser asks. The header pill should turn into "backend + cluster OK".

## Talk script (5 min)

The narrative starts with a **superhero movie clip**: the hero, under pressure, orders his AI **"put everything we have into the thrusters"**. Thesis: that kind of raw order, with no context or pleasantries, is exactly what an AI that rambles or stalls cannot answer — and in production you must decide instantly. Jev answers a typed question with probabilities at the tap, and that decision scales real compute.

Stage checklist, in order:

- [ ] **Terminal 1**: `npm run dev` (with `TYPESAFE_API_KEY` exported). Terminal 2 next to it: `kubectl get pods -l app=nginx-voice -w` — you'll see pods being born live.
- [ ] **Opening segment with Hermes**: open `http://localhost:3000/pods.html` — it shows only the pod squares (no Jev) for the Hermes intro, the screen the audience sees while the other AI runs the cluster.
- [ ] **Kickoff**: show the hero-and-his-AI clip, tell the thesis, and show the cluster with its **3 pods** and the green pill on the web page. Grab the microphone.
- [ ] **Scale up**: say **"Put everything we have into the cluster"**. Point in order at: the transcript under "What I said" → Jev's thinking bars → the confidence → the ⚡ **Jev decided in N ms** line (the number to compare with the slow model from the opening segment) → the **squares going from 3 to 10** (they appear orange while starting and turn green when ready; the manifest carries an artificial ~1s readiness delay and the UI polls every 500ms, so the orange stays visible on stage); in the other window, the new pods `Running`.
- [ ] **Scale down**: say **"Everything is back to normal"**. The squares return to **3**: seven turn red for a moment (dying) and disappear.
- [ ] *(If there's spare time)* say something irrelevant ("today is tuesday"): Jev hesitates, the policy discards it and **nothing scales**.
- [ ] **Capper**: *"My voice just scaled how much compute is running."*

## Mock mode (`JEV_MOCK=1`)

To rehearse without an API key (or without a reliable venue wifi):

```bash
JEV_MOCK=1 npm run dev
```

Jev is replaced by an **offline, deterministic** keyword classifier (`src/mock-jev.ts`). Each keyword is matched as a **word start** (left-anchored word boundary: `\b<keyword>`), so prefixes keep working ("saturat" matches "saturated") but substring collisions do not ("unstable" does not match "stable"). Lists (evaluated in this order):

- `high`: "a lot/high/saturat/peak/everything we have/thruster/all the power/max"
- `normal`: "normal/usual/stable/chill/calm"
- `low`: "little/low/nothing/without"
- anything else → `unsure` (discarded). In particular "we have little power available" falls into `low` (the word "power" alone was removed from `high` on purpose) and "the service is unstable" falls into `unsure`. Same flow, same pods, zero network.

Before going on stage, a full system smoke test (applies the manifest, waits for the rollout, scales with the hero's order to 10, back to 3 with "everything is back to normal", checks that an irrelevant command does not scale, and leaves everything at 3 replicas):

```bash
bash scripts/e2e-mock.sh
```

## Configuration

All variables are read from the environment (`src/config.ts`); none are mandatory except `TYPESAFE_API_KEY` in real mode.

| Variable              | Default         | Purpose                                                                  |
| --------------------- | --------------- | ------------------------------------------------------------------------ |
| `TYPESAFE_API_KEY`    | *(empty)*       | TypeSafe AI API key. Required except with `JEV_MOCK=1`.                   |
| `JEV_MOCK`            | *(empty)*       | `1` = deterministic offline classifier, no network or API key.            |
| `K8S_DEPLOYMENT`      | `nginx-voice`   | Deployment to scale.                                                      |
| `K8S_NAMESPACE`       | `default`       | Deployment's namespace.                                                   |
| `K8S_POD_SELECTOR`    | `app=nginx-voice` | Pod selector for the squares' state breakdown.                            |
| `K8S_KUBECONFIG`      | *(empty)*       | Path to an external cluster's kubeconfig (`--kubeconfig` flag).           |
| `K8S_CONTEXT`         | *(empty)*       | Context to use inside the kubeconfig (`--context` flag).                  |
| `CONFIDENCE_THRESHOLD`| `0.5`           | Jev's minimum confidence: below it, nothing is scaled (skipped).          |
| `PORT`                | `3000`          | HTTP server port.                                                         |

## Pointing at an external cluster

By default the backend talks to the cluster of kubectl's current context.
To point at an external cluster without touching `~/.kube/config`:

1. Copy the target cluster's kubeconfig to a file (e.g.
   `./external.kubeconfig`; the `*.kubeconfig` pattern is in `.gitignore`, do
   not commit it) and set `K8S_KUBECONFIG=./external.kubeconfig` in your `.env`.
2. If the cluster is already in your current kubeconfig, just set
   `K8S_CONTEXT=name` (list the contexts with `kubectl config get-contexts`).
3. Reload the environment and restart the server:

   ```bash
   set -a; source .env; set +a
   npm run dev
   ```

Both pages (`/` and `/pods.html`) then show the external cluster. With both
variables empty the behaviour is the usual one (kubectl's default context).

kubectl also honours its own `KUBECONFIG` variable (merge of several files);
if it is set, the explicit `K8S_KUBECONFIG` flag wins.

## API

| Method | Route                 | What it does                                                            |
| ------ | --------------------- | ----------------------------------------------------------------------- |
| POST   | `/api/voice-command`  | Classifies `{"text": "..."}` with Jev and scales (or not) the deployment. |
| GET    | `/api/status`         | Deployment's current state and pod breakdown (what the squares panel uses). |

Scaling to 10 replicas with the hero's order:

```bash
curl -s -X POST http://localhost:3000/api/voice-command \
  -H 'Content-Type: application/json' \
  -d '{"text":"put everything we have into the cluster"}'
```

```json
{
  "transcript": "put everything we have into the cluster",
  "classification": {
    "choice": "high",
    "probabilities": { "high": 0.92, "normal": 0.05, "low": 0.02, "unsure": 0.01 },
    "confidence": 0.92
  },
  "action": { "type": "scaled", "replicas_before": 3, "replicas_after": 10 },
  "timings": { "classify_ms": 842, "total_ms": 1431 }
}
```

`timings` measures in ms (integers) how long Jev took to classify (`classify_ms`) and how long the full flow took (`total_ms`); the frontend shows it next to the confidence.

`action.type` is `scaled`, `skipped` (hesitant phrase or low confidence) or `error` (kubectl failed mid-flow).

Current state:

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

Errors: `400` empty or non-JSON body, `413` body > 10 KB, `502` with `{"error": ...}` if Jev could not classify, `503` on `/api/status` if kubectl fails. Never a 500 because of Jev or kubectl.

## Troubleshooting

- **The microphone does not work**: use Chrome or Edge (`webkitSpeechRecognition` does not exist in Firefox/Safari) and access via `http://localhost:3000`; also check the OS and browser microphone permissions.
- **Plan B without voice**: type the command in the UI text field ("…or type the command here and press Enter") and hit Send; it goes through exactly the same flow.
- **kubectl with the wrong context**: check `kubectl config current-context` and switch with `kubectl config use-context <context>`; the backend uses the kubeconfig's current context.
- **"The deployment does not exist"** (or the pod panel shows `—`): apply the demo manifest with `kubectl apply -f k8s/deployment.yaml` and check with `kubectl get deployment nginx-voice`.
- **The Jev API stalls or fails** (502 in the log): rehearse with `JEV_MOCK=1`, where there is no network in the classification path.
- **Is everything broken?** Run the tests: `npm test` (plus `npm run typecheck`). The tests **never call the real API** or a cluster.

## Repo structure

```
jev-kubectl-voice/
├── package.json          # npm scripts (dev, start, test, typecheck) and dependencies
├── .env.example          # environment variable template (copy to .env)
├── tsconfig.json         # TypeScript configuration
├── src/
│   ├── server.ts         # HTTP server: /api/* routes, public/ static files, voice flow
│   ├── config.ts         # typed environment variables + replicas per traffic level
│   ├── jev.ts            # real Jev classifier (TypeSafe AI, choice question) and factory
│   ├── mock-jev.ts       # deterministic keyword mock classifier
│   ├── policy.ts         # pure policy: classification → scale or skip
│   ├── kubectl.ts        # kubectl wrapper (get/scale) without a shell, typed errors
│   └── *.test.ts         # tests with node:test (never touch the real API or the cluster)
├── public/
│   ├── index.html        # UI: microphone, transcript, Jev's thinking, pod squares
│   ├── app.js            # Web Speech API + /api/status polling + command sending
│   ├── pods.html         # squares-only screen for the Hermes opening segment (no Jev)
│   ├── pods.js           # its own /api/status polling every 500 ms, independent of app.js
│   └── style.css         # styles, all local (the venue wifi cannot be trusted)
├── k8s/
│   └── deployment.yaml   # nginx-voice deployment (nginx:alpine, 3-replica baseline)
└── scripts/
    └── e2e-mock.sh       # complete end-to-end smoke test in mock mode
```