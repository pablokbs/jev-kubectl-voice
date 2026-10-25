# Review: frases de héroe + alto a 10
**Verdict**: NEEDS_FIXES
**Tests**: 68 pass / 0 fail (`npm test`, node:test; observado, no solo reclamado)
**Typecheck**: clean (`npm run typecheck` / `tsc --noEmit`, sin salida de error)

## Issues

1. **src/mock-jev.ts:28 — "tenemos poca potencia disponible" se clasifica como `alto` (debe ser `bajo'); escala a 10 en vivo por una frase de baja capacidad.** Verificado empíricamente replicando la lógica del mock (`normalize` + `includes` + orden alto→normal→bajo): la palabra clave de `alto` `"potencia"` matchea como substring y gana antes de que `bajo` se evalúe. Agravante: la keyword de `bajo` es `"poco"` y la frase dice `"poca"`, así que aunque el orden fuera inverso tampoco caería en `bajo`. Es exactamente la trampa señalada en el alcance. Fixes sugeridos (cualquiera, idealmente con test de regresión en `src/jev.test.ts` para "tenemos poca potencia disponible" → `bajo`; hoy no existe):
   - Cambiar la keyword de `alto` de `"potencia"` a frases sin ambigüedad (`"toda la potencia"`, `"potencia al maximo"`, `"potencia maxima"`) — la línea de película real ya está cubierta por `"todo lo que"`/`"propulsor"`/`"maximo"`, así que el bare `"potencia"` es prescindible; y
   - Agregar `"poca"` (o `"poc"`) a las keywords de `bajo`, y/o una guarda previa: si el texto contiene `"poc"` cerca de una keyword de `alto`, no escalar. Alternativa mínima: evaluar antes de `alto` una lista de negaciones (`"poca potencia"`, `"poco tráfico"`, …).

2. **src/mock-jev.ts:29 — colisión latente del mismo tipo en `normal`: `"estable"` es substring de `"inestable"`.** "El servicio está inestable" → `normal` (confirmado empíricamente) cuando semánticamente no lo es. Misma familia de fix (frases/bordes de palabra en lugar de `includes` a pelo, o keyword `"estable"` → `" todo estable"`/word-boundary). No bloquea las 6 frases del guion, pero conviene arreglarlo junto con el issue 1.

3. **public/style.css:482 — comentario stale "de 3 a 6 réplicas (misma fila) no sacuda el layout del proyector"** — el spec exige que todas las refs 3→6 pasen a 3→10; esta quedó. Es solo un comentario de diseño, pero contradice el rango real (1..10 réplicas) que el CSS debe tolerar. Fix: cambiar a "de 3 a 10 réplicas".

4. **public/index.html:48, public/index.html:107, public/app.js:390 — la UI (lo que se proyecta) sigue sugiriendo las frases viejas de tráfico**: hint "Pulsá el micro y hablá: 'tenemos mucho tráfico'" y "Frases de ejemplo: 'tenemos mucho tráfico' · 'el tráfico es normal'". Funciona con el mock (`"mucho"` se conservó a propósito — correcto no flaggear eso), pero el guion reescrito manda decir "Pone todo lo que tenemos en el cluster" / "Ya está todo normal"; en el escenario el público vería prompts que no coinciden con la narrativa del clip de superhéroes. Fix: actualizar los hints a las frases de héroe (o añadirlas junto a las de tráfico).

## Verificado OK (sin issue)

- **Auditoría de colisiones, resto de entradas**: "pone todo lo que tenemos en el cluster" → `alto` (via `"todo lo que"`), "poné todo lo que tenemos en los propulsores" → `alto` (tildes normalizadas NFD), "ya está todo normal" → `normal` (NO hay keyword `"todo"` a pelo en `alto` — la guarda del comentario se cumple), "está tranqui" → `normal`, "hay poco tráfico" → `bajo`. Todas confirmadas ejecutando la lógica real.
- **src/jev.ts**: el texto de la pregunta `choice` (líneas 38–43) coincide byte a byte con lo que asserta `src/jev.test.ts:85` y cubre ambas familias ("máxima capacidad **o mucho tráfico** = alto" — órdenes de emergencia y descripciones de tráfico). Estado `{ comando_del_operador, replicas_actuales }` coherente con `src/jev.test.ts:76` (no hay historia git para difear — repo sin commits —, pero src↔tests son coherentes).
- **Números de réplicas**: `src/config.ts` `trafficReplicas.alto = 10`; `k8s/deployment.yaml` cita `{bajo:1, normal:3, alto:10}`; `src/policy.test.ts` y `src/server.test.ts` usan 10; README (diagrama + guion) 3→10 en todos lados. Único "6" replica-stale: el comentario de CSS del issue 3.
- **Frases viejas**: `scripts/e2e-mock.sh` usa solo frases de héroe; las viejas quedan solo en tests de regresión y keywords del mock (intencional, no flaggeadas) — salvo los hints de UI del issue 4.
- **Contrato e2e**: `e2e-mock.sh` grepea substrings JSON compactos (`"choice":"alto"`, `"choice":"normal"`, `"type":"skipped"`) y el servidor serializa con `JSON.stringify` sin espacios (`sendJson` en src/server.ts:168) — matchean. `wait_replicas "$REPLICAS_ALTO"` (10) antes que `wait_replicas "$REPLICAS_BASE"` (3). La frase del paso 4 cae en `alto` con confianza 0.92 > umbral 0.5 → `scaled` a 10; la del paso 5 → `normal` → 3; "hoy es martes" → `no_se` → `skipped`.
- **Coherencia README ↔ mock ↔ Jev**: la lista de keywords que documenta el README en "Modo ensayo" es idéntica a `KEYWORDS`; todas las frases del guion reproducen la clasificación prometida (además cubiertas por `src/jev.test.ts:110-117`).
