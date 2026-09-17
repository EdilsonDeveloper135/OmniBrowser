# Resultados de pruebas de concepto

Fecha de ejecución de referencia: 2026-09-16.

## Entorno

| Campo | Valor |
|---|---|
| Equipo | Apple M4 Pro, 14 CPU lógicas, 48 GiB RAM |
| Arquitectura | arm64 |
| Sistema | macOS 27.0 (26A428) |
| Electron | 44.4.1 |
| Resolución Retina observada | `devicePixelRatio = 2` |

Los comandos usan fixtures HTTP locales y directorios temporales; no dependen de cuentas ni servicios externos.

## POC 1: perfiles y almacenamiento

```bash
npm run test:poc:storage
```

Resultado: pasa.

- A y B, con la misma partición persistente, leen el mismo token en cookie persistente, cookie de sesión, `localStorage`, IndexedDB y Cache Storage.
- C, con otra partición, no lee esos valores.
- A/B comparten el registro y control de service worker.
- La segunda carga valida uso de caché HTTP de la misma partición.
- Después de flush, cierre y relanzamiento: sobreviven cookie persistente, `localStorage`, IndexedDB, Cache Storage y service worker.
- La cookie sin expiración no reaparece.
- Una partición sin `persist:` comparte dentro del proceso y queda vacía al relanzar.
- Reasignar una tarjeta mediante destrucción/recreación cambia la sesión sin mutar el perfil de origen.

## POC 2: canvas con vistas nativas

```bash
npm run test:poc:canvas
```

Resultado: pasa.

- Tres `WebContentsView` siguen `screen = origin + pan + world × zoom`.
- Se comprobaron bounds de contenido, solapamiento, selección, re-add para z-order, resize, ocultamiento fuera del viewport y Retina 2×.
- Evidencia: [`canvas-arm64.png`](canvas-arm64.png), captura compuesta de la ventana (1200×749 px) en la que la vista seleccionada, roja, se ve sobre la verde.

El POC captura la ventana compuesta con `desktopCapturer` y, si no puede, con `screencapture`; ambas necesitan que el proceso que lo lanza tenga permiso de grabación de pantalla. Sin ese permiso macOS solo devuelve la superficie del shell: el POC comprueba entonces la vista seleccionada a través de su página, avisa por stderr y registra `captureMethod: "shell-only-capturePage"`. En CI se exige la captura compuesta (`OMNIBROWSER_REQUIRE_COMPOSITE_CAPTURE=1`), que los runners arm64 y x64 obtienen con `desktopCapturer`.

La captura de cada ejecución se guarda en `test-results/poc/canvas-<arch>.png`. La evidencia versionada solo se reemplaza con `OMNIBROWSER_UPDATE_VISUAL_EVIDENCE=1 npm run test:poc:canvas`, y el script se niega si la captura no incluye las vistas nativas.

## POC 3: popups y autenticación

```bash
npm run test:poc:popup
```

Resultado: pasa.

- `window.open` y `target="_blank"` crean una tarjeta con la sesión del opener.
- El runtime adopta el `WebContents` suministrado por Electron.
- `window.opener`, `postMessage` y `window.close` se conservan.
- Un destino no permitido se bloquea.

Esto valida la primitiva, no garantiza aceptación de un proveedor OAuth concreto. Los proveedores pueden bloquear navegadores embebidos por política propia.

## POC 4: recursos y suspensión

```bash
npm run test:poc:resources
```

Resultado: pasa. Las cifras siguientes son working set total observado en KiB y solo describen el equipo indicado.

| Vistas | Visibles | Ocultas (`setVisible(false)`) | Fuera de viewport | Suspendidas | Reactivada una |
|---:|---:|---:|---:|---:|---:|
| 1 | 432,720 | 434,736 | 435,024 | 345,200 | 436,240 |
| 5 | 801,024 | 801,296 | 802,912 | 349,648 | 440,320 |
| 10 | 1,259,728 | 1,260,064 | 1,260,864 | 355,088 | 446,048 |

Interpretación limitada: ocultar reduce composición, pero no libera el working set como destruir los `WebContents`. La suspensión manual sí mostró una reducción grande en esta ejecución y el wake reconstruyó perfil, URL e historial. No se deduce un límite universal de tarjetas ni se activa autosuspensión.

## POC 5: compuerta de gestos de trackpad

```bash
npm run test:poc:gestures
```

Fecha: 2026-09-17. Resultado: pasa en tres ejecuciones consecutivas en arm64. Pasa mientras se cumpla la premisa de la compuerta: ningún hook del proceso principal puede cancelar la rueda antes de que una `WebContentsView` desplace su página.

| Medida | Resultado |
|---|---|
| Control: `mouseDown` cancelado en `before-mouse-event` | la página recibe 0 `mousedown` |
| 12 eventos de rueda vertical con deltas de trackpad, cancelados en todos los hooks | `before-mouse-event` y `before-input-event` no los ven; `input-event` recibe 24 `mouseWheel` y 12 de cada `gestureScrollBegin/Update/End`, pero la página se desplaza 480 px y recibe 12 `wheel`; el shell no recibe ninguno |
| Rueda horizontal hacia Atrás en una página con historial y después hacia la derecha | el índice de historial no cambia, no hay eventos `swipe` y la página se desplaza en horizontal (720, 720 y 300 px) |

La entrada se sintetiza con `sendInputEvent`, que llega a la misma función de reenvío de rueda que los eventos nativos tras el hit-testing de macOS; no sustituye la matriz física de trackpad. Si una versión de Electron hace fallar este POC, la compuerta puede reconsiderarse siguiendo [la arquitectura](../architecture.md) y el [inventario de QA](../qa-inventory.md).

## Ejecución agregada

```bash
npm run test:poc
```

El script falla al primer gate incumplido. Cada POC trabaja en un directorio temporal propio que se elimina si pasa y se conserva, con su ruta en stderr, si falla. Cada actualización de Electron debe volver a ejecutar los cinco POC en arm64 y x64 antes de cambiar el ADR o generar una release.
