# Traducir la demo al inglés

## Goal

Traducir por completo la demo (UI, reconocimiento de voz, clasificador Jev/mock, mensajes de error, tests, README, script e2e, manifest, env y descripción del package) al inglés, en un branch nuevo (`translate-to-english`), con commit y push al final.

## Constraints

- No cambiar comportamiento ni arquitectura: misma API HTTP, mismo flujo, mismas reglas de política, mismos delays de readiness/polling.
- La demo queda operando en inglés: reconocimiento `en-US`, comandos de voz en inglés, preguntas a Jev en inglés.
- `npm test` y `npm run typecheck` deben pasar al final.
- El script e2e (`scripts/e2e-mock.sh`) usa los mismos comandos en inglés.
- Los tests anti-spoiler (`src/demo-assets.test.ts`) se actualizan: las frases del guion en inglés NO deben filtrarse a `public/`.

## Chunks

### Chunk 1 — Backend: dominio, mensajes y comentarios

**Files Changed:**
- `src/config.ts` — `TrafficLevel`: `"bajo"|"normal"|"alto"` → `"low"|"normal"|"high"`; `trafficReplicas` `{ low: 1, normal: 3, high: 10 }`; mensajes de error (`readInt`/`readFloat`/`requireTypesafeApiKey`) y comentarios en inglés.
- `src/jev.ts` — `TraficoChoice` → `TrafficChoice` con valores `"low"|"normal"|"high"|"unsure"`; tipos `TraficoQuestion` → `TrafficQuestion`, `TraficoSystemOneResult` → `TrafficSystemOneResult`; state keys `comando_del_operador` → `operator_command`, `replicas_actuales` → `current_replicas`; clave de pregunta `trafico` → `traffic`; instrucciones de la pregunta en inglés ("Capacity level the operator is asking for the service based on their command: maximum capacity or heavy traffic = high, everything normal = normal, light usage = low"); comentarios en inglés.
- `src/mock-jev.ts` — `DISTRIBUTIONS` con claves `low/normal/high/unsure`; `KEYWORDS` en inglés:
  - `high`: `["a lot", "high", "saturat", "peak", "everything we have", "thruster", "all the power", "max"]`
  - `normal`: `["normal", "usual", "stable", "chill", "calm"]`
  - `low`: `["little", "low", "nothing", "without"]`
  - Comentarios en inglés, conservando las advertencias de colisión: nunca `"power"` sola en high (robaría "little power available" → low), nunca `"everything"` sola (robaría "everything is back to normal"), nunca `"no"` sola (prefijo de "normal" con el ancla `\b`).
- `src/policy.ts` — razones de `skip` en inglés; comentarios en inglés.
- `src/kubectl.ts` — mensajes de `KubectlError` y `TypeError` en inglés; comentarios en inglés.
- `src/server.ts` — todos los mensajes de error HTTP, `UNKNOWN_ROUTE_ERROR`, arranque (console.log), `PLACEHOLDER_HTML` en inglés (mantener mención a "phase 2", la exige un test), `PODS_EN_CEROS` → `ZERO_POD_STATES`, comentarios en inglés.

**Depends On:** ninguno (es la base).  
**Accept When:** `npm test` y `tsc` pasan (Chunk 3 ajusta los tests que referencian estos identificadores; se ejecutan juntos). Claves nuevas visibles en respuestas JSON (`choice: "high"`, `probabilities: { low, normal, high, unsure }`).  
**Test Coverage:** se actualizan `src/jev.test.ts`, `src/server.test.ts`, `src/policy.test.ts` (Chunk 3) contra estos contratos.

### Chunk 2 — Frontend: UI en inglés

**Files Changed:**
- `public/index.html` — `lang="es"` → `"en"`; título; "Lo que dije" → "What I said"; "El pensamiento de Jev" → "Jev's thinking"; "Registro de acciones" → "Action log"; leyenda `corriendo/arrancando/muriendo` → `running/starting/terminating`; placeholder, hints, aria-labels, pill "conectando…" → "connecting…".
- `public/app.js` — reconocimiento `es-ES` → `en-US`; `NIVELES` claves `low/normal/high/unsure` con nombres "low traffic"/"normal traffic"/"high traffic"/"not sure"; strings de UI ("you haven't said anything yet…", "thinking…", "Press the mic and speak.", "⚡ Jev decided in N ms", "✅ scaled to N replicas (was: X)", "⏭️ no action — …", errores de micrófono, "X/Y ready", "backend + cluster OK", "no cluster data"); comentarios en inglés. **Se mantienen** nombres internos de funciones/variables/classes (p. ej. `pintarPods`, `ultimaFirmaPods`) — ver Decision Log.
- `public/pods.html` — `lang="en"`; "Estado del cluster" → "Cluster status"; leyenda y pill en inglés; comentarios en inglés. No debe contener "jev" (test anti-spoiler) ni los ids prohibidos.
- `public/pods.js` — pill y subline en inglés; comentarios en inglés.
- `public/style.css` — selectores `.nivel-bajo/.nivel-normal/.nivel-alto/.nivel-no_se` → `.nivel-low/.nivel-normal/.nivel-high/.nivel-unsure` (los emite `app.js` como `nivel-${clave}`); comentarios en inglés. Resto de clases CSS se mantienen.

**Depends On:** Chunk 1 (claves de nivel).  
**Accept When:** strings en inglés; `lang="en"`; sin frases del guion en `public/` (los tests de `demo-assets.test.ts` lo verifican).  
**Test Coverage:** `src/demo-assets.test.ts` (Chunk 3) se actualiza a los nuevos strings.

### Chunk 3 — Tests en inglés

**Files Changed:**
- `src/jev.test.ts` — frases de la tabla en inglés (ver Decision Log para la lista exacta); estado esperado `{ operator_command, current_replicas }`; pregunta `traffic` con criteria `{ low, normal, high, unsure }` e instructions en inglés; `/simulated network failure/`; `"test-key"`; test de normalización: mayúsculas ("HIGH TRAFFIC") y diacríticos (palabra sintética con acento que normaliza a keyword, p. ej. "saturatéd" → high) para conservar cobertura de NFD.
- `src/policy.test.ts` — `REPLICAS { low: 1, normal: 3, high: 10 }`; casos con `high`/`unsure`; `/unsure/i`; descripciones en inglés.
- `src/server.test.ts` — payloads "we have heavy traffic"/"heavy traffic" etc.; expectativas `choice: "high"`/`"unsure"`; regexes de razones en inglés (`/Could not scale/`, `/below the threshold/`, `/could not confirm/`, `/Could not classify/`, `/string/`, `/cannot be empty/`, `/JSON/`, `/10 KB/`, `/phase 2/`); errores fake en inglés ("cluster down", "get timed out", "unexpected command", "Jev is down"); comentarios en inglés.
- `src/kubectl.test.ts` — comentarios y datos en inglés ("my-cluster.yaml", "not-json", "apiserver internal error {").
- `src/config.test.ts` — descripciones en inglés (assertions no cambian).
- `src/demo-assets.test.ts` — `FRASES_DEL_GUION` → ["put everything we have into the cluster", "put everything we have into the thrusters", "everything is back to normal", "everything we have"]; hint `"Press the mic and speak."` en index.html y app.js; leyenda `running/starting/terminating` en pods.html; `"decided in"` en app.js; comentarios en inglés.

**Depends On:** Chunks 1 y 2 (contratos y strings).  
**Accept When:** `npm test` verde (suite completa, incluidos anti-spoiler).  
**Test Coverage:** la suite completa.

### Chunk 4 — Docs y ops en inglés

**Files Changed:**
- `README.md` — traducción completa al inglés, incluidos: arquitectura, requisitos, puesta en marcha, guion de la charla (comandos: "put everything we have into the thrusters", "Put everything we have into the cluster", "Everything is back to normal", "today is tuesday"), modo ensayo con keywords en inglés, tabla de configuración, API (curl con texto en inglés), solución de problemas y estructura del repo.
- `.env.example` — comentarios en inglés.
- `scripts/e2e-mock.sh` — mensajes de log en inglés; comandos: `{"text":"put everything we have into the cluster"}` → grep `"choice":"high"`; `{"text":"everything is back to normal"}` → grep `"choice":"normal"`; `{"text":"today is tuesday"}` → `"type":"skipped"`; `REPLICAS_ALTO` → `REPLICAS_HIGH`.
- `k8s/deployment.yaml` — comentarios en inglés.
- `package.json` — `description` en inglés.

**Depends On:** Chunk 1 (keywords del mock que documenta el e2e/README).  
**Accept When:** sin texto en español en estos archivos.  
**Test Coverage:** los comandos del e2e están cubiertos además por la tabla de `jev.test.ts`.

### Chunk 5 — Branch, verificación, commit y push

**Files Changed:** ninguno de código.

**Pasos:**
1. `git checkout -b translate-to-english`.
2. `npm test` y `npm run typecheck` en verde.
3. Verificación extra: ejecutar `MockClassifier` directo con `node --import tsx -e` sobre las frases del guion (no requiere cluster) y comprobar `low/normal/high/unsure`.
4. Grep final de rastros en español en archivos trackeados (tildes/ñ/¿¡) → solo falsos positivos esperados (nombres propios como "nginx").
5. `git add` por path explícito; commit en español con `Co-Authored-By: Kimchi <noreply@kimchi.dev>`; `git push -u origin translate-to-english`.

**Depends On:** Chunks 1–4.  
**Accept When:** branch remoto creado con el commit; tests y typecheck verdes.

## Verification Strategy

- `npm test` (suite completa: server, jev, mock vía jev.test, política, kubectl, config, assets anti-spoiler).
- `npm run typecheck`.
- Prueba manual de `MockClassifier` con las frases del guion en inglés (sin red ni cluster).
- Grep final de español en archivos trackeados.

## Decision Log

- **Valores de dominio traducidos**: `bajo→low`, `alto→high`, `no_se→unsure` en TODOS lados (type `TrafficLevel`/`TrafficChoice`, `trafficReplicas`, respuestas JSON `choice`/`probabilities`, criteria de la pregunta de Jev, `DISTRIBUTIONS`, `NIVELES` del frontend, selectores CSS `nivel-*`). Alternativa rechazada: dejar las claves internas en español y solo traducir strings — hubiera dejado la demo mitad en español (ej. `probabilities: { alto: 0.92 }` en una charla en inglés).
- **State keys de la API de Jev traducidas** (`operator_command`, `current_replicas`) y clave de pregunta `traffic`: son parte del contrato interno del demo; los tests los verifican.
- **Identificadores internos se conservan**: nombres de funciones/variables CSS (p. ej. `pintarPods`, `ultimaFirmaPods`, `.log-escalado`) NO se renombran. La traducción cubre strings visibles, comentarios, tipos exportados con palabras en español (`Trafico*` → `Traffic*`) y valores de dominio. Evita un refactor masivo sin valor de usuario y mantiene el diff revisable. Excepción: selectores `nivel-*` (derivan de los valores de dominio) y `PODS_EN_CEROS` → `ZERO_POD_STATES` (constante de módulo trivial).
- **Reconocimiento de voz es-ES → en-US**: la demo ahora se opera en inglés; sin esto, los comandos en inglés se transcribirían mal.
- **Keywords del mock en inglés** con las mismas garantías de colisión que el original (ancla `\b` izquierda): `saturat` matchea "saturated/saturating"; `stable` NO matchea "unstable" (sin word boundary); `power` sola NO está en high; `everything` sola NO está en high; `no` sola NO está en low (prefijo robaría "normal").
- **Tabla de frases de `jev.test.ts` en inglés** (equivalente semántico):
  - "we have a lot of traffic" → high; "the traffic is normal" → normal; "there is little traffic" → low; "today is tuesday" → unsure
  - "put everything we have into the cluster" → high; "put everything we have into the thrusters" → high; "everything is back to normal" → normal
  - Regresiones de colisión: "we have little power available" → low; "the service is unstable" → unsure; "we have little power, we're toast" → low.
- **Test de tildes adaptado**: el NFD ya no es necesario para inglés, pero `normalize()` sigue en el código; se conserva cobertura con "HIGH TRAFFIC" (mayúsculas) y una palabra acentuada sintética ("saturatéd" → high).

## Risks

- **Mismatch de selectores CSS `nivel-*`**: si `app.js` emite `nivel-low` y CSS conserva `.nivel-bajo`, las barras pierden color. Mitigación: renombrar los 4 selectores en el mismo chunk y verificar con grep tras editar.
- **Colisión de keywords en inglés**: mitigado por la tabla de regresiones en `jev.test.ts` (los mismos casos de colisión que el original).
- **Strings afirmados en tests** (`demo-assets`, `server.test`) podrían quedar desincronizados: se actualizan en el Chunk 3 y se validan con `npm test`.
- **Rewrite grande de `README.md`**: traducción cuidadosa, sin cambiar comandos reales (`npm install`, `kubectl apply`, etc.).