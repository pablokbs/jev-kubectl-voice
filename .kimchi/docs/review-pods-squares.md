# Review: cuadraditos de pods
**Verdict**: NEEDS_FIXES
**Tests**: 65 pass / 0 fail (10 suites) — `npm test`
**Typecheck**: clean — `tsc --noEmit`

## Issues

1. `README.md` — texto desactualizado que describe la UI vieja del número gigante, ahora reemplazada por los cuadraditos:
   - "Qué verás en pantalla": *"Un **contador gigante de pods** ... que salta de 3 a 6 mientras los pods nacen."* — ya no existe un contador gigante.
   - Guion de la charla: *"el **contador saltando a 6**"* y *"El contador vuelve a **3**"* — el orador no tiene contador que señalar; el efecto visible ahora son los cuadraditos (verde/naranja/rojo) y la leyenda.
   - Fix sugerido: reescribir esas líneas en términos de los cuadraditos (uno por pod, verde corriendo / naranja arrancando / rojo terminando, subline "X/Y listos"), p. ej. *"los cuadraditos saltando de 3 a 6"*. Nota: las secciones de configuración (`K8S_POD_SELECTOR`) y el ejemplo JSON de `/api/status` con `pods` ya están bien actualizadas; solo estas descripciones narrativas quedaron viejas.

## Notas de verificación (sin acción requerida)

- **Clasificación de pods** (`src/kubectl.ts`, `classifyPod`): correcta. `deletionTimestamp` se evalúa primero; `running` exige `phase === "Running"` + `containerStatuses` array no vacío + todos `ready === true` (tolera entradas `null` con `?.`); pods sin `status`/items no-objeto caen en `starting`; `items` ausente o no-array → todo ceros. Cubierto por 8 tests nuevos que asertan VALORES (`deepStrictEqual` con `{running,starting,terminating}`).
- **Sin shell**: `getPodStates` reusa el runner inyectable y el array `["get","pods","-l",selector,"-n",ns,"-o","json"]`; grep no encontró `exec(` ni `innerHTML` en `src/` ni `public/`. `pintarPods` solo usa `createElement`/`textContent`.
- **Signature caching** (`public/app.js`): firma `${running}:${starting}:${terminating}`; polling idéntico no toca el DOM; 3→6 cambia la firma y redibuja; 503 (`pintarPodsVacios`) resetea la firma a `null` y es idempotente mientras el placeholder "—" ya esté pintado, así que la recuperación redibuja una sola vez. Orden de render running → starting → terminating según spec.
- **Contrato 200/503**: `server.ts` mantiene forma constante (`pods` en ceros en 503, `PODS_EN_CEROS` compartido solo se serializa, nunca se muta); `Promise.all` hace 503 aunque solo falle el lector de pods — comportamiento asertado por tests con valores exactos. `app.js` consume `datos.pods` y valida números >= 0.
- **CSS** (`public/style.css` 484–563, 664): cuadrados `clamp(26px,4vw,56px)`, `min-height` estable en `.pods-cuadricula`, pop-in `podPop`, colores `#3ddc84` / `#ffab2e` / `#ff5252`, latido solo en starting, chips de leyenda con `animation: none`. Las clases de la leyenda en `index.html` coinciden (`pod-square--running|starting|terminating`).
- **Comportamiento existente intacto**: flujo de voz, `getStatus` y `scaleDeployment` sin cambios de comportamiento; tests preexistentes siguen pasando.
- Menor deliberado: caption `pod-ready` renderiza `"3/6 listos"` (equivalente al "X de Y listos" pedido; no es desviación funcional).
