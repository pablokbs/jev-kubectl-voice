#!/usr/bin/env bash
#
# End-to-end smoke test of the demo (Jev mock mode).
#
# What it does:
#   1. Preflight: checks kubectl and node, and that the current cluster responds.
#   2. Applies k8s/deployment.yaml and waits for the rollout (3 replicas).
#   3. Starts the backend in mock mode (JEV_MOCK=1, port 3199).
#   4. Hero voice command ("put everything we have into the cluster")
#      -> the deployment scales to 10 replicas.
#   5. "everything is back to normal" -> back to 3 replicas.
#   6. Irrelevant command      -> no scaling (classification discarded).
#   7. Cleanup ALWAYS (EXIT trap): kills the server and leaves 3 replicas.
#
# Usage: bash scripts/e2e-mock.sh   (run from any directory)
# Output: exit 0 if everything passes, exit 1 if something fails (state reported).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PORT=3199
DEPLOY="nginx-voice"
NAMESPACE="default"
REPLICAS_BASE=3
REPLICAS_HIGH=10
BASE_URL="http://localhost:${PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVER_PID=""

# ---------------------------------------------------------------------------
# Log utilities
# ---------------------------------------------------------------------------
info()  { echo "ℹ️  $*"; }
ok()    { echo "✅ $*"; }
fail()  { echo "❌ $*" >&2; }
step()  { echo ""; echo "== $* =="; }

# ---------------------------------------------------------------------------
# Cleanup: ALWAYS runs on exit (success, failure or interrupt).
# Kills only the server PID and restores the replicas to 3.
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  set +e

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi

  local current_replicas
  current_replicas="$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "unknown")"
  if [[ "$current_replicas" != "$REPLICAS_BASE" ]]; then
    echo "♻️  Restoring ${DEPLOY} replicas to ${REPLICAS_BASE} (current value: ${current_replicas})..."
    kubectl scale deployment "$DEPLOY" -n "$NAMESPACE" --replicas="$REPLICAS_BASE" >/dev/null 2>&1
  fi

  echo ""
  echo "Final deployment state:"
  kubectl get deployment "$DEPLOY" -n "$NAMESPACE" 2>/dev/null \
    || echo "  (could not query the state of ${DEPLOY})"

  if [[ "$exit_code" -eq 0 ]]; then
    echo "✅ Smoke test completed: the system is back to its base state."
  else
    echo "❌ Smoke test FAILED (code ${exit_code}): check the steps marked with ❌ above." >&2
  fi
  set -e
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Cluster and HTTP helpers
# ---------------------------------------------------------------------------

# Current replicas of the deployment (empty string or "unknown" on failure).
current_replicas() {
  kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "unknown"
}

# wait_replicas <expected> <timeout_s>: polls until spec.replicas matches.
wait_replicas() {
  local expected="$1" timeout_s="$2"
  local waited=0 actual
  while (( waited < timeout_s )); do
    actual="$(current_replicas)"
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  fail "The deployment did not reach ${expected} replicas in ${timeout_s}s (last value: ${actual})."
  return 1
}

# post_voice <json>: POST to /api/voice-command; prints the response body.
post_voice() {
  curl -sS -X POST -H 'Content-Type: application/json' \
    -d "$1" "${BASE_URL}/api/voice-command"
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
step "Step 1/6: environment preflight"

command -v kubectl >/dev/null 2>&1 \
  || { fail "kubectl is not installed or not on the PATH. Install it (for example with 'brew install kubectl') and try again."; exit 1; }
ok "kubectl available: $(command -v kubectl)"

command -v node >/dev/null 2>&1 \
  || { fail "node is not installed or not on the PATH. Install it (for example with 'brew install node') and try again."; exit 1; }
ok "node available: $(node --version)"

if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  fail "kubectl cannot reach the current context's cluster ('kubectl get ns ${NAMESPACE}' failed)."
  echo "   Check your kubeconfig and connection: 'kubectl config current-context' and 'kubectl cluster-info'." >&2
  exit 1
fi
ok "Cluster reachable: namespace \"${NAMESPACE}\" responds."

# ---------------------------------------------------------------------------
# 2. Apply the manifest and wait for the rollout
# ---------------------------------------------------------------------------
step "Step 2/6: applying k8s/deployment.yaml and waiting for the rollout"

kubectl apply -f "${REPO_ROOT}/k8s/deployment.yaml"
kubectl rollout status "deployment/${DEPLOY}" -n "$NAMESPACE" --timeout=180s

initial_replicas="$(current_replicas)"
if [[ "$initial_replicas" != "$REPLICAS_BASE" ]]; then
  fail "The deployment ended with ${initial_replicas} replicas (expected ${REPLICAS_BASE})."
  exit 1
fi
ok "Deployment ${DEPLOY} ready with ${REPLICAS_BASE} replicas."

# ---------------------------------------------------------------------------
# 3. Start the backend in mock mode
# ---------------------------------------------------------------------------
step "Step 3/6: starting the backend (JEV_MOCK=1, port ${PORT})"

cd "$REPO_ROOT"
JEV_MOCK=1 PORT="$PORT" node --import tsx src/server.ts &
SERVER_PID=$!
info "Server in the background (PID ${SERVER_PID})."

# Wait until it accepts connections (200 or 503 from /api/status), ~15s cap.
server_ready=0
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "The server died on startup. Check the node error message above."
    exit 1
  fi
  http_code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/status" || echo "000")"
  if [[ "$http_code" == "200" || "$http_code" == "503" ]]; then
    server_ready=1
    break
  fi
  sleep 0.5
done
if [[ "$server_ready" -ne 1 ]]; then
  fail "The server did not respond at ${BASE_URL}/api/status after 15s (last HTTP code: ${http_code:-000})."
  exit 1
fi
ok "Server accepting connections (HTTP ${http_code} from /api/status)."

# ---------------------------------------------------------------------------
# 4. Hero's order -> 10 replicas
# ---------------------------------------------------------------------------
step "Step 4/6: \"put everything we have into the cluster\" -> scale to ${REPLICAS_HIGH} replicas"

high_response="$(post_voice '{"text":"put everything we have into the cluster"}')"
if ! grep -q '"choice":"high"' <<<"$high_response"; then
  fail "The response does not contain \"choice\":\"high\". Response: ${high_response}"
  exit 1
fi
ok "Jev classified as \"high\"."

if ! wait_replicas "$REPLICAS_HIGH" 60; then
  exit 1
fi
ok "The deployment scaled to ${REPLICAS_HIGH} replicas."

# ---------------------------------------------------------------------------
# 5. Back-to-normal order -> 3 replicas
# ---------------------------------------------------------------------------
step "Step 5/6: \"everything is back to normal\" -> back to ${REPLICAS_BASE} replicas"

normal_response="$(post_voice '{"text":"everything is back to normal"}')"
if ! grep -q '"choice":"normal"' <<<"$normal_response"; then
  fail "The response does not contain \"choice\":\"normal\". Response: ${normal_response}"
  exit 1
fi
ok "Jev classified as \"normal\"."

if ! wait_replicas "$REPLICAS_BASE" 60; then
  exit 1
fi
ok "The deployment returned to ${REPLICAS_BASE} replicas."

# ---------------------------------------------------------------------------
# 6. Irrelevant command -> no scaling
# ---------------------------------------------------------------------------
step "Step 6/6: \"today is tuesday\" -> no replica changes"

noise_response="$(post_voice '{"text":"today is tuesday"}')"
if ! grep -q '"type":"skipped"' <<<"$noise_response"; then
  fail "Expected action.type \"skipped\" (irrelevant command). Response: ${noise_response}"
  exit 1
fi
if grep -q '"type":"scaled"' <<<"$noise_response"; then
  fail "The irrelevant command triggered a scaling (action.type \"scaled\"). Response: ${noise_response}"
  exit 1
fi
ok "The irrelevant command was discarded (action.type \"skipped\")."

sleep 3
replicas_after_noise="$(current_replicas)"
if [[ "$replicas_after_noise" != "$REPLICAS_BASE" ]]; then
  fail "Replicas changed without a scaling command: ${replicas_after_noise} (expected ${REPLICAS_BASE})."
  exit 1
fi
ok "Replicas remain at ${REPLICAS_BASE}: no spurious scaling."

exit 0