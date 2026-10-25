# Verification: hero-phrases fixes (review-hero-phrases.md)

## Test output

`npm test` (node:test) — **71 pass / 0 fail / 0 skipped** (68 previos + 3 casos de regresión nuevos en la tabla de frases del mock: "tenemos poca potencia disponible" → bajo, "el servicio está inestable" → no_se, "poca potencia, estamos al horno" → bajo). Cola del run:

```
ℹ tests 71
ℹ suites 10
ℹ pass 71
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 170.971958
```

## Typecheck output

`npm run typecheck` (tsc --noEmit) — **clean, sin salida de error**:

```
> jev-kubectl-voice@0.1.0 typecheck
> tsc --noEmit
```

## Live mock smoke

Servidor: `JEV_MOCK=1 PORT=3241 node --import tsx src/server.ts`. Deployment arrancó en 3/3.

1) `POST /api/voice-command` — "pone todo lo que tenemos en el cluster" → `alto`, escaló 3→10, `readyReplicas` llegó a **10** (poll jsonpath):

```json
{"transcript":"pone todo lo que tenemos en el cluster","classification":{"choice":"alto","probabilities":{"alto":0.92,"normal":0.05,"bajo":0.02,"no_se":0.01},"confidence":0.92},"action":{"type":"scaled","replicas_before":3,"replicas_after":10}}
```

2) `POST /api/voice-command` — "tenemos poca potencia disponible" → **clasifica `bajo`** (el fix del review: ya no roba la keyword "potencia" de alto). NOTA: la acción NO fue `skipped` — fue `scaled` 10→1. Esto es el comportamiento correcto del sistema: `src/policy.ts` solo omite (`skip`) para `no_se` o confianza < umbral; un `bajo` legítimo escala a `replicasMap.bajo = 1` (src/config.ts:16). La expectativa "skipped — replicas stay 10" de la orden de verificación no correspondía a la política real; la corrección pedida por el review (issues 1) era solo la CLASIFICACIÓN → `bajo`, y se cumple:

```json
{"transcript":"tenemos poca potencia disponible","classification":{"choice":"bajo","probabilities":{"alto":0.03,"normal":0.06,"bajo":0.9,"no_se":0.01},"confidence":0.9},"action":{"type":"scaled","replicas_before":10,"replicas_after":1}}
```

3) `POST /api/voice-command` — "ya está todo normal" → `normal`, escaló de vuelta a 3, `readyReplicas` = **3**:

```json
{"transcript":"ya está todo normal","classification":{"choice":"normal","probabilities":{"alto":0.06,"normal":0.9,"bajo":0.03,"no_se":0.01},"confidence":0.9},"action":{"type":"scaled","replicas_before":1,"replicas_after":3}}
```

Limpieza: servidor del smoke muerto, **puerto 3241 libre** (`lsof -ti:3241` vacío), deployment **3/3**. El dev server preexistente del usuario en puerto 3000 (`tsx watch`, PID 64686 y su hijo) quedó intacto y responde (`/api/status` OK).

## Verdict: ALL_PASS

Fixes aplicados: (1+2) `src/mock-jev.ts` matcheo left-anchored `\b<keyword>` escapada + keywords "toda la potencia"/"potencia maxima" en alto (fuera la "potencia" peluda) y tallo "poc" en bajo; (tests) 3 regresiones nuevas; (3) comentario CSS "de 3 a 10 réplicas"; (4) hints de héroe en `public/index.html` (mic-hint + footer) y `public/app.js`; README "Modo ensayo" sincronizado con las listas y la regla `\b`. Único desvío, documentado arriba: el paso 2 del smoke devuelve `scaled`→1 (política real de `bajo`), no `skipped`; la clasificación pedida por el review es correcta.
