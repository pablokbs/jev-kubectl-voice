#!/usr/bin/env bash
#
# Smoke test end-to-end de la demo (modo mock de Jev).
#
# Qué hace:
#   1. Preflight: comprueba kubectl y node, y que el cluster actual responde.
#   2. Aplica k8s/deployment.yaml y espera el rollout (3 réplicas).
#   3. Arranca el backend en modo mock (JEV_MOCK=1, puerto 3199).
#   4. Comando de voz del héroe ("pone todo lo que tenemos en el cluster")
#      -> el despliegue escala a 10 réplicas.
#   5. Comando de voz "ya está todo normal" -> vuelve a 3 réplicas.
#   6. Comando irrelevante     -> no escala (clasificación descartada).
#   7. Limpieza SIEMPRE (trap EXIT): mata el servidor y deja 3 réplicas.
#
# Uso: bash scripts/e2e-mock.sh   (ejecutar desde cualquier directorio)
# Salida: exit 0 si todo pasa, exit 1 si algo falla (estado reportado).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
PORT=3199
DEPLOY="nginx-voice"
NAMESPACE="default"
REPLICAS_BASE=3
REPLICAS_ALTO=10
BASE_URL="http://localhost:${PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVER_PID=""

# ---------------------------------------------------------------------------
# Utilidades de log
# ---------------------------------------------------------------------------
info()  { echo "ℹ️  $*"; }
ok()    { echo "✅ $*"; }
fail()  { echo "❌ $*" >&2; }
step()  { echo ""; echo "== $* =="; }

# ---------------------------------------------------------------------------
# Limpieza: se ejecuta SIEMPRE al salir (éxito, fallo o interrupción).
# Mata solo el PID del servidor y restaura las réplicas a 3.
# ---------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  set +e

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi

  local replicas_actuales
  replicas_actuales="$(kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "desconocido")"
  if [[ "$replicas_actuales" != "$REPLICAS_BASE" ]]; then
    echo "♻️  Restaurando réplicas de ${DEPLOY} a ${REPLICAS_BASE} (valor actual: ${replicas_actuales})..."
    kubectl scale deployment "$DEPLOY" -n "$NAMESPACE" --replicas="$REPLICAS_BASE" >/dev/null 2>&1
  fi

  echo ""
  echo "Estado final del despliegue:"
  kubectl get deployment "$DEPLOY" -n "$NAMESPACE" 2>/dev/null \
    || echo "  (no se pudo consultar el estado de ${DEPLOY})"

  if [[ "$exit_code" -eq 0 ]]; then
    echo "✅ Smoke test completado: el sistema quedó en su estado base."
  else
    echo "❌ Smoke test FALLIDO (código ${exit_code}): revisa los pasos marcados con ❌ arriba." >&2
  fi
  set -e
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers de cluster y HTTP
# ---------------------------------------------------------------------------

# Réplicas actuales del despliegue (cadena vacía o "desconocido" si falla).
replicas_actuales() {
  kubectl get deployment "$DEPLOY" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "desconocido"
}

# wait_replicas <esperado> <timeout_s>: sondea hasta que spec.replicas coincida.
wait_replicas() {
  local esperado="$1" timeout_s="$2"
  local waited=0 actual
  while (( waited < timeout_s )); do
    actual="$(replicas_actuales)"
    if [[ "$actual" == "$esperado" ]]; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  fail "El despliegue no llegó a ${esperado} réplicas en ${timeout_s}s (último valor: ${actual})."
  return 1
}

# post_voice <json>: POST a /api/voice-command; imprime el cuerpo de la respuesta.
post_voice() {
  curl -sS -X POST -H 'Content-Type: application/json' \
    -d "$1" "${BASE_URL}/api/voice-command"
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
step "Paso 1/6: preflight del entorno"

command -v kubectl >/dev/null 2>&1 \
  || { fail "kubectl no está instalado o no está en el PATH. Instálalo (por ejemplo con 'brew install kubectl') y vuelve a intentar."; exit 1; }
ok "kubectl disponible: $(command -v kubectl)"

command -v node >/dev/null 2>&1 \
  || { fail "node no está instalado o no está en el PATH. Instálalo (por ejemplo con 'brew install node') y vuelve a intentar."; exit 1; }
ok "node disponible: $(node --version)"

if ! kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  fail "kubectl no puede alcanzar el cluster del contexto actual ('kubectl get ns ${NAMESPACE}' falló)."
  echo "   Revisa tu kubeconfig y tu conexión: 'kubectl config current-context' y 'kubectl cluster-info'." >&2
  exit 1
fi
ok "Cluster alcanzable: el namespace \"${NAMESPACE}\" responde."

# ---------------------------------------------------------------------------
# 2. Aplicar el manifiesto y esperar el rollout
# ---------------------------------------------------------------------------
step "Paso 2/6: aplicar k8s/deployment.yaml y esperar el rollout"

kubectl apply -f "${REPO_ROOT}/k8s/deployment.yaml"
kubectl rollout status "deployment/${DEPLOY}" -n "$NAMESPACE" --timeout=180s

replicas_iniciales="$(replicas_actuales)"
if [[ "$replicas_iniciales" != "$REPLICAS_BASE" ]]; then
  fail "El despliegue quedó con ${replicas_iniciales} réplicas (esperaba ${REPLICAS_BASE})."
  exit 1
fi
ok "Despliegue ${DEPLOY} listo con ${REPLICAS_BASE} réplicas."

# ---------------------------------------------------------------------------
# 3. Arrancar el backend en modo mock
# ---------------------------------------------------------------------------
step "Paso 3/6: arrancar el backend (JEV_MOCK=1, puerto ${PORT})"

cd "$REPO_ROOT"
JEV_MOCK=1 PORT="$PORT" node --import tsx src/server.ts &
SERVER_PID=$!
info "Servidor en segundo plano (PID ${SERVER_PID})."

# Esperar a que acepte conexiones (200 o 503 de /api/status), tope ~15s.
server_listo=0
for _ in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "El servidor murió al arrancar. Revisa el mensaje de error de node arriba."
    exit 1
  fi
  codigo_http="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/status" || echo "000")"
  if [[ "$codigo_http" == "200" || "$codigo_http" == "503" ]]; then
    server_listo=1
    break
  fi
  sleep 0.5
done
if [[ "$server_listo" -ne 1 ]]; then
  fail "El servidor no respondió en ${BASE_URL}/api/status tras 15s (último código HTTP: ${codigo_http:-000})."
  exit 1
fi
ok "Servidor aceptando conexiones (HTTP ${codigo_http} de /api/status)."

# ---------------------------------------------------------------------------
# 4. Orden del héroe -> 10 réplicas
# ---------------------------------------------------------------------------
step "Paso 4/6: \"pone todo lo que tenemos en el cluster\" -> escalar a ${REPLICAS_ALTO} réplicas"

respuesta_alto="$(post_voice '{"text":"pone todo lo que tenemos en el cluster"}')"
if ! grep -q '"choice":"alto"' <<<"$respuesta_alto"; then
  fail "La respuesta no contiene \"choice\":\"alto\". Respuesta: ${respuesta_alto}"
  exit 1
fi
ok "Jev clasificó como \"alto\"."

if ! wait_replicas "$REPLICAS_ALTO" 60; then
  exit 1
fi
ok "El despliegue escaló a ${REPLICAS_ALTO} réplicas."

# ---------------------------------------------------------------------------
# 5. Orden de normalidad -> 3 réplicas
# ---------------------------------------------------------------------------
step "Paso 5/6: \"ya está todo normal\" -> volver a ${REPLICAS_BASE} réplicas"

respuesta_normal="$(post_voice '{"text":"ya está todo normal"}')"
if ! grep -q '"choice":"normal"' <<<"$respuesta_normal"; then
  fail "La respuesta no contiene \"choice\":\"normal\". Respuesta: ${respuesta_normal}"
  exit 1
fi
ok "Jev clasificó como \"normal\"."

if ! wait_replicas "$REPLICAS_BASE" 60; then
  exit 1
fi
ok "El despliegue volvió a ${REPLICAS_BASE} réplicas."

# ---------------------------------------------------------------------------
# 6. Comando irrelevante -> no escala
# ---------------------------------------------------------------------------
step "Paso 6/6: \"hoy es martes\" -> sin cambios de réplicas"

respuesta_ruido="$(post_voice '{"text":"hoy es martes"}')"
if ! grep -q '"type":"skipped"' <<<"$respuesta_ruido"; then
  fail "Se esperaba action.type \"skipped\" (comando irrelevante). Respuesta: ${respuesta_ruido}"
  exit 1
fi
if grep -q '"type":"scaled"' <<<"$respuesta_ruido"; then
  fail "El comando irrelevante disparó un escalado (action.type \"scaled\"). Respuesta: ${respuesta_ruido}"
  exit 1
fi
ok "El comando irrelevante fue descartado (action.type \"skipped\")."

sleep 3
replicas_tras_ruido="$(replicas_actuales)"
if [[ "$replicas_tras_ruido" != "$REPLICAS_BASE" ]]; then
  fail "Las réplicas cambiaron sin un comando de escalado: ${replicas_tras_ruido} (esperaba ${REPLICAS_BASE})."
  exit 1
fi
ok "Las réplicas se mantienen en ${REPLICAS_BASE}: sin escalado espurio."

exit 0
