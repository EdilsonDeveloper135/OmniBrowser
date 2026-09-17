# Hardening, optimización y validación posterior al canvas espacial (2026-09)

Fecha: 2026-09-17. Base: `main` en `d7597c5` (`feat: add spatial canvas organization`), rama `codex/harden-optimize-omnibrowser`. Las cifras son observaciones de una sola máquina: sirven para comparar antes y después en ella, no son benchmarks universales ni gates de CI.

## 1. Entorno

| Elemento | Valor |
|---|---|
| Equipo | Apple M4 Pro, 14 CPU lógicas, 48 GiB, pantalla interna de 1728×1117 pt (área útil 1728×1025), escala 2 |
| Sistema | macOS 27.0 (26A428) |
| Node.js / npm | 24.21.0 oficial, tarball verificado contra `SHASUMS256.txt` de nodejs.org / 11.19.0; `SDKROOT` = MacOSX26.5.sdk |
| Electron / Chromium | 44.4.1 / 152.0.7977.78 |
| No disponible | Mac Intel/x64 (Rosetta no instalado: `arch -x86_64` devuelve `Bad CPU type`) y una persona operando trackpad y diálogos nativos |

## 2. Línea base antes de cambios

| Comprobación | Resultado |
|---|---|
| `npm run verify` | pasa: typecheck, lint y 106 unitarias en 14 archivos |
| `npm run test:poc` | pasan los 4 POC; el de canvas **reescribe `docs/poc-results/canvas-arm64.png`** con una captura sin vistas nativas (H-07) |
| `npm run package` / `npm run test:e2e:only` | pasa / 25 E2E en 37.1 s |
| `npm run test:perf` | 8 observaciones; con 500 tarjetas: latencia de búsqueda 31.9–33.9 ms vista desde Playwright, 12 vistas visibles, error de borde 0.4 px |
| `npm audit --omit=dev` / `npm audit` | 0 / 22 paquetes (21 altos, 1 moderado) |
| CI de GitHub en `d7597c5` (run 35175784359) | **falla la E2E en ambas arquitecturas**. arm64 (3): oclusión de superficies Chromium, pan/zoom por teclado y selección múltiple con Shift. x64 (2): arranque sin red (aviso de carga no visto) y fullscreen/minimizar/bloqueo (timeout de 30 s). En `c8db7a1` (run 35139543567) falló arm64 en la prueba de oclusión (`Expected: 2, Received: 1`) |

## 3. Hallazgos

Estados: corregido, diferido con motivo, no reproducible, falso positivo, requiere decisión de producto.

| ID | Área | Hallazgo y evidencia | Estado |
|---|---|---|---|
| H-01 | Dependencias | La documentación daba `webpack-dev-server` 5.2.6 por afectado. Los 6 GHSA tienen versión corregida ≤ 5.2.6 y Forge adoptó 5.2.x en `main` sin cambios de runtime (electron/forge#4274, #4329) | corregido: override 5.2.6 y documentación |
| H-02 | Dependencias | `extract-zip@2.0.1` (2 GHSA altos) no tiene versión corregida; Electron publica el sustituto `@electron-internal/extract-zip`, que `electron@44.4.1` ya usa y que `@electron/packager` ≥ 20.0.1 adoptó | corregido: override con `.app` idéntico y hook de fechas |
| H-03 | Dependencias | La excepción de `image-size` afirmaba que el proyecto no configura imágenes de DMG; `electron-installer-dmg` pasa siempre su `background.png` a `appdmg`. `image-size@0.7.5` no contiene analizadores JXL/HEIF | diferido con motivo; excepción reescrita en [security-audit.md](security-audit.md) |
| H-04 | Dependencias | GitHub mostraba 8 alertas y npm 22: Dependabot cuenta GHSA por manifiesto y había auto-descartado las 2 de `image-size`; npm cuenta cada paquete dependiente | documentado |
| H-05 | CI/E2E | Las ventanas E2E de 1440×900 dependen del tamaño de la pantalla virtual del runner, que es pequeño y variable (actions/runner-images#9345, #8620, #393). Mecanismo reproducido: macOS reduce una ventana mayor que el área útil al mostrarla (1440×1325 → 1440×1025) | corregido localmente; pendiente de confirmar en CI |
| H-06 | Producto | Los avisos emitidos antes de que el shell se suscriba se pierden. El aviso de fallo de carga del browser restaurado sale 3–11 ms después de `bootstrap` en esta máquina; con el script del shell servido 700 ms tarde se pierde en 3 de 3 arranques, igual que en el fallo x64 de CI | corregido: `ShellNotices` retiene los avisos hasta `bootstrap`; unitarias y E2E que falla sin la corrección |
| H-07 | Evidencia | `npm run test:poc` sobrescribe la evidencia versionada del canvas, incluso con una captura sin vistas nativas cuando falta el permiso de grabación de pantalla | corregido: la captura va a `test-results/poc`; solo se actualiza la evidencia con una captura compuesta y `OMNIBROWSER_UPDATE_VISUAL_EVIDENCE=1`; CI exige captura compuesta |
| H-08 | Documentación | `poc-results/README.md` describía la evidencia como captura del shell de 2400×1500 px; el PNG versionado es una captura compuesta de 1200×749 px con las vistas nativas | corregido |
| H-09 | Pruebas | El arnés de rendimiento (4 clics) y la E2E de zoom semántico (hasta 8 clics) dependían de un número fijo de clics, válido solo para el zoom sembrado | corregido: se detienen al observar la capa esperada, con un máximo derivado de `MIN_ZOOM`, `MAX_ZOOM` y `ZOOM_STEP` |
| H-10 | Compuerta | `setPreferences` aceptaba y persistía `historySwipeEnabled: true` aunque el gesto no está publicado | corregido: el contrato IPC solo admite `false` y el modelo lo normaliza al cargar y al guardar; la unitaria falla contra `d7597c5` |
| H-11 | Gestos | Electron 44.4.1 no ofrece un punto cancelable para la rueda antes de que la página desplace su contenido (sección 6) | compuerta cerrada; requiere nueva evidencia de Electron |
| H-12 | Rendimiento | Con 500 tarjetas, cada evento de runtime de una página y cada movimiento de arrastre o de rueda re-renderizaban en React todas las tarjetas y filas del árbol: ~4.6 ms de script por evento de runtime y 10–15 ms por movimiento | corregido: filas y tarjetas memoizadas con acciones de identidad estable |
| H-13 | Rendimiento | La medición de overlays leía geometría del DOM tras cada evento de runtime | corregido: solo se repite cuando cambia la geometría dibujada u otro estado de overlay |
| H-14 | Memoria | Cada tarjeta que ha estado visible conserva su `WebContents` (~100 MiB) hasta suspenderla: 12 → 24 → 36 vistas al panear | requiere decisión de producto (sección 7.4) |
| H-15 | Producto | Tras un pan, las etiquetas de zona, chips colapsados y menús de tarjeta seguían registrados como oclusores en su posición de pantalla anterior: con un pan de 300 px la vista nativa de una tarjeta cubrió una etiqueta de zona | corregido: esos oclusores se registran en coordenadas del mundo y se proyectan con la cámara actual; unitaria y E2E que falla sin la corrección |
| H-16 | Descargas | Mientras el diálogo nativo espera respuesta, Chromium ya escribe la descarga en un temporal oculto de `~/Downloads`, también en perfiles Private | documentado; la mitigación es decisión de producto (sección 8) |
| H-17 | Producto | Shift+clic dentro de una página no añadía su tarjeta a la selección múltiple: Electron no serializa `modifiers` en los eventos de ratón de `input-event` (`Converter<blink::WebMouseEvent>::ToV8`) | corregido: estado de Shift desde `before-input-event` del shell y de cada página; E2E que falla sin la corrección |
| H-18 | Desarrollo | `npm start` servía el renderer en todas las interfaces (`*:3000`); el logger de Forge sigue en `*:9000` sin opción de host | corregido para el dev server (`localhost`); logger documentado como residual |
| H-19 | Pruebas | Los runners de POC nunca borraban su directorio temporal: cada `npm run test:poc` dejaba 5 directorios con perfiles Chromium (hasta ~6 MB cada uno) en `$TMPDIR`, donde había 65 acumulados | corregido: se borran al pasar y se conservan, con su ruta en stderr, al fallar; una ejecución completa no añade directorios |

No hay marcadores `TODO`, `FIXME`, `XXX` ni `HACK` en el código, las pruebas o la documentación versionados (sección 10).

## 4. Dependencias

Detalle, procedencia y condiciones de retirada en [security-audit.md](security-audit.md).

| | Antes | Después |
|---|---:|---:|
| `npm audit --omit=dev` | 0 | 0 |
| `npm audit` (paquetes) | 22: 21 altos, 1 moderado | 4 altos |
| GHSA distintos | 10: 4 altos, 6 moderados | 2 altos de `image-size` (excepción) |
| Alertas abiertas de Dependabot en `main` | 8: 2 altas (`extract-zip`), 6 moderadas (`webpack-dev-server`) | se comprobará al fusionar; el lockfile ya no contiene versiones afectadas de esos paquetes |

Cambios del lockfile: 56 paquetes nuevos y 10 actualizados en el subárbol de `webpack-dev-server` 5, una entrada nueva para el alias de `extract-zip` bajo `@electron/packager`, y 19 paquetes retirados (la cadena `extract-zip`/`yauzl` y dependencias de `webpack-dev-server` 4 como `node-forge`). No se usó `npm audit fix --force`.

## 5. Robustez de CI y E2E

- **Pantallas pequeñas.** Con `OMNIBROWSER_E2E=1` la ventana admite un tamaño mayor que la pantalla (`enableLargerThanScreen`). `tests/support/app-window.ts` trae la ventana al frente, fija 1440×900 y espera a que proceso principal, renderer y `visibilityState` coincidan; si no ocurre, el error incluye el área útil. Comprobado con el bundle de producción: 1440×1300 visibles sobre un área útil de 1025 px.
- **Avisos al arrancar.** Orden medido en el proceso principal: `did-finish-load` del shell +154 ms, `bootstrap` +181–187 ms, `did-fail-load` y aviso +190–192 ms. `tests/e2e/fixtures/slow-shell-main.cjs` ejecuta el mismo bundle sirviendo tarde el JavaScript del shell para reproducir la carrera de forma determinista.
- **Diagnóstico en CI.** El workflow informa la resolución de la pantalla virtual y sube `test-results/` y `playwright-report/` cuando falla la suite. Estos cambios no se han ejecutado en GitHub: la rama no se ha publicado.
- **Zoom semántico.** E2E y rendimiento cambian de modo por clics hasta observar `.semantic-layer` o `.canvas-world`.

## 6. Gestos de trackpad

### Evidencia de código (Electron 44.4.1, Chromium 152.0.7977.78)

1. `before-mouse-event` se emite desde `RenderWidgetHostImpl::ForwardMouseEventWithLatencyInfo` (parche `revert_partial_remove_unused_prehandlemouseevent.patch`), que solo acepta tipos entre `kMouseTypeFirst` (`kMouseDown`) y `kMouseTypeLast` (`kContextMenu`). `kMouseWheel` queda fuera.
2. La rueda entra por `RenderWidgetHostImpl::ForwardWheelEventWithLatencyInfo`, sin delegado ni callback cancelable.
3. `input-event` informa de la rueda y de `gestureScroll*` como observación: `preventDefault()` no la detiene.
4. `api::WebContents::CanOverscrollContent()` devuelve `false`: Electron no activa la navegación por overscroll de Chromium.
5. El evento `swipe` de `BrowserWindow` solo llega desde `swipeWithEvent:` con deltas discretos (±1) del modo de swipe antiguo de macOS, sin posición ni cancelación del scroll.
6. AppKit entrega la rueda a la vista bajo el puntero; la `WebContentsView` está sobre el shell, así que el shell no la recibe.

### POC `gesture-interception-gate`

`npm run test:poc:gestures` (incluido en `test:poc`). Tres ejecuciones consecutivas en arm64:

| Medida | Resultado |
|---|---|
| Control: `mouseDown` cancelado en `before-mouse-event` | la página recibe 0 `mousedown` |
| 12 eventos de rueda vertical con deltas de trackpad, cancelados en todos los hooks | `before-mouse-event` y `before-input-event`: 0 eventos; `input-event`: 24 `mouseWheel` y 12 de cada `gestureScrollBegin/Update/End`; la página se desplaza 480 px y recibe 12 `wheel`; el shell, 0 |
| Rueda horizontal hacia Atrás sobre una página con historial y después hacia la derecha | índice de historial sin cambios (2), 0 eventos `swipe`, desplazamiento horizontal de 720, 720 y 300 px |

El POC usa `sendInputEvent`, que entra por la misma función de reenvío que la rueda nativa después del hit-testing de macOS. No sustituye la matriz física. En CI se ejecutará también en x64.

### Comportamiento publicado

La E2E `wheel input over a live browser scrolls only its page, selected or not, and the empty canvas still pans` comprueba que la rueda sobre una tarjeta activa o inactiva solo desplaza su página, sin mover la cámara, la geometría ni la selección, y que la rueda sobre canvas vacío sigue paneando.

### Estado de la compuerta

- `historySwipeEnabled` sigue en `false`, no hay toggle público y el contrato IPC rechaza `true`.
- **Matriz física: no ejecutada.** No hay Mac Intel y en esta sesión no se autorizó el control de la UI de OmniBrowser. Aunque se ejecutara, la evidencia anterior impide consumir la rueda antes de la página, así que no bastaría para publicar el gesto.
- **Para reabrirla:** una versión de Electron con un hook cancelable para `WebMouseWheelEvent` (el POC fallará al detectarlo), o la decisión de producto de no componer contenido vivo en tarjetas inactivas (por ejemplo, mostrar una captura) para que el shell reciba la rueda. Después, matriz física en Apple Silicon e Intel con el protocolo de [qa-inventory.md](qa-inventory.md).

## 7. Rendimiento

Arnés: `npm run test:perf` con el bundle de producción. Métricas nuevas del renderer: intervalos de `requestAnimationFrame` (la pantalla funciona a 120 Hz: p50 de 8.3 ms), tareas largas, CPU del proceso del shell y tiempos del dominio `Performance` de DevTools (tarea, script, estilo y layout del hilo principal).

### 7.1 Con 500 tarjetas

Antes: dos ejecuciones aisladas de los escenarios y una de la suite completa (esta última sin tiempos de hilo principal). Después: dos ejecuciones aisladas con el renderer final y dos de la suite completa final, la segunda dentro de la verificación final tras `npm ci`. Mismo bundle salvo el renderer; la corrección de Shift (H-17) está en el proceso principal y no interviene en estos escenarios.

| Escenario | Métrica | Antes | Después |
|---|---|---:|---:|
| Arrastre con snap, 60 movimientos | script del shell | 606–667 ms | 193–196 ms |
| | tarea total del shell | 695–758 ms | 304–315 ms |
| | layout | 13.0–13.1 ms | 12.8–13.0 ms |
| | frame p95 / máximo | 16.7–16.8 / 17.6–25.7 ms | 9.3–10.3 / 9.4–10.4 ms |
| | CPU del shell / total | 5.1–5.4 % / 5.9–6.4 % | 2.0–2.3 % / 3.1–3.4 % |
| Pan con rueda, 60 eventos | script del shell | 864–887 ms | 239–247 ms |
| | tarea total | 1 073–1 102 ms | 518–532 ms |
| | estilo / layout | 19.1–19.2 / 34.3–38.9 ms | 21.7–23.2 / 52.9–60.1 ms |
| | frame p95 / máximo | 16.7–16.8 / 17.4–25.0 ms | 9.2–10.3 / 9.4–10.4 ms |
| | CPU del shell / total | 5.1–5.3 % / 6.6–6.9 % | 2.6–2.7 % / 4.4–4.6 % |
| 12 páginas cambiando el título cada 100 ms, 5 s (240 eventos) | script del shell | 1 092–1 110 ms | 301–318 ms |
| | tarea total | 1 345–1 354 ms | 720–773 ms |
| | layout | 64–67 ms (86 pasadas) | 133–160 ms (72–78 pasadas) |
| | frame p95 / máximo | 9.2–16.5 / 17.5 ms | 9.2–10.2 / 9.4–10.4 ms |
| | CPU del shell / total | 2.6 % / 3.0–3.1 % | 1.3 % / 2.1–2.3 % |
| Búsqueda en el árbol | render en el shell: filtrar / restaurar 500 filas | 3.0–3.5 / 9.6–10.3 ms | 3.3–4.4 / 10.3–10.8 ms |
| | latencia vista desde Playwright (incluye ida y vuelta CDP) | 23.9–28.2 ms | 24.2–41.0 ms |

No hubo tareas largas (> 50 ms) antes ni después. La búsqueda no cambia de forma material: filtrar 500 filas cuesta 0.95 ms (7.5) y el resto es render; los 41 ms son una sola ejecución de la suite completa, con el render interno en 4.4 ms. El aumento de layout en pan y títulos se explica en 7.6.

### 7.2 IPC, `setBounds` y alineación

| Escenario (5 tarjetas) | `commit-layout` | `setBounds` | escrituras | alineación final |
|---|---:|---:|---:|---:|
| reposo, 5 s | 0 → 0 | 0 → 0 | 0 → 0 | — |
| 5 títulos cada 100 ms, 5 s (100 eventos) | 0 → 0 | 0 → 0 | 3 → 3 | — |
| pan / arrastre / resize, 60 frames | 59 → 59 | 295/59/59 → 295/59/59 | 2/1/1 → 2/1/1 | 0.4 → 0.4 px |

Con 500 tarjetas el renderer procesa ahora más frames, así que llegan más lotes: arrastre con snap 26–32 → 43–44 `commit-layout`; pan con rueda 52–53 → 59 lotes y 462–474 → 528 `setBounds` (15 vistas, 9 visibles). Sigue habiendo como máximo un lote en vuelo y la alineación final es 0.4 px.

### 7.3 Memoria y procesos

- Ciclos de 1, 5 y 10 tarjetas (visible, oculta por zoom semántico, fuera del viewport, suspendida, una despierta): variación del working set entre −1.0 % y +0.8 % en las dos suites completas finales, con los mismos procesos y vistas.
- 500 tarjetas (arrastre con snap): 16 procesos (Browser, GPU, Utility y 13 Tab: 12 páginas visibles y el shell), 1 940–1 946 MiB antes y 1 820–1 837 MiB después. En la suite completa, los procesos Tab bajan de 1 550 a 1 442–1 448 MiB; el cambio del renderer es la causa probable, pero no se aisló por proceso. Las 488 tarjetas restantes no tienen `WebContents`.

### 7.4 Vistas retenidas al panear (H-14)

Dos ejecuciones de la suite completa final, 500 tarjetas estáticas, zoom 80 %; cada paso desplaza tres filas (672 px):

| Etapa | Vistas (visibles) | Procesos | Working set |
|---|---:|---:|---:|
| inicio | 12 (12) | 16 | 1 716 MiB |
| tras bajar 3 filas | 24 (12) | 28 | 2 917 MiB |
| tras bajar 6 filas | 36 (12) | 40 | 4 106 MiB |
| tras suspender las 24 ocultas | 12 (12) | 16 | 1 883–1 899 MiB |

Es el diseño actual: ocultar no destruye y no hay suspensión automática. Recorrer un workspace grande termina con un proceso por tarjeta vista (~100 MiB cada uno). Una política como un máximo de vistas ocultas con suspensión LRU (excluyendo tarjetas con audio, descargas, formularios editados o fijadas) cambia qué estado de página se conserva, así que requiere decisión de producto. No se detectaron vistas ni listeners filtrados: las E2E de wake/sleep/close repetidos, cierre con descarga, reasignación y salida siguen sin vistas sobrantes.

### 7.5 Derivaciones puras (`npm run bench`)

Media en ms con 500 browsers: una ejecución antes y tres después (una tras las optimizaciones y dos en la verificación final). Estas funciones no cambiaron (en `geometry.ts` solo se añadieron funciones nuevas), así que las diferencias de hasta ~10 % son variación entre ejecuciones.

| Función | Antes | Después |
|---|---:|---:|
| `buildSidebarTreeIndex` | 0.037 | 0.036–0.038 |
| filtro de búsqueda (una pulsación) | 0.93 | 0.95–0.96 |
| `computeCanvasLayout` | 0.12 | 0.13–0.14 |
| `snapMovedWorldRect` contra 499 tarjetas | 0.034 | 0.035 |
| `mergeBrowserState` (un evento) | 0.002 | 0.002 |
| clave del lote (`JSON.stringify`) | 0.099 | 0.099–0.111 |
| validación `layoutBatchSchema` | 0.35 | 0.35–0.36 |
| `WorkspaceModel.commitLayout` sin cambios | 0.16 | 0.16 |
| `WorkspaceModel.toSnapshot` | 0.99 | 1.00–1.11 |
| `toPersistentFile` + serialización (20 entradas de historial) | 11.2 | 11.5–12.2 |

### 7.6 Layout y núcleos de eficiencia

En el escenario de títulos, cada pasada de layout subió de ~0.8 a ~2 ms. Un trace de 3 s con invalidation tracking muestra las mismas causas en `d7597c5` y en la rama: 292 cambios de texto y pasadas completas sobre 15 183 objetos; en `d7597c5`, 52 pasadas y 41.3 ms; en la rama, 43 pasadas y 104 ms. Por bisección, solo con los cambios del canvas da 46.7 ms y al añadir las filas memoizadas del árbol sube a 78–108 ms.

Experimento controlado sobre el mismo trace:

| | JS | layout |
|---|---:|---:|
| sin memoizar, máquina en reposo | 514.5 ms | 48.2 ms |
| memoizado, máquina en reposo | 227.0 ms | 103.3 ms |
| sin memoizar, carga sintética en 4 núcleos | 276.2 ms | 32.3 ms |
| memoizado, carga sintética en 4 núcleos | 68.7 ms | 29.1 ms |

Con la máquina ocupada, las dos versiones hacen el mismo layout y la memoizada gasta un 75 % menos de JS. En reposo, con menos JavaScript, macOS ejecuta más el hilo del shell en núcleos de eficiencia y el mismo layout tarda más en tiempo de pared; el trabajo no aumenta. La tarea total del hilo principal baja en todos los escenarios (7.1).

## 8. Descargas y privacidad Private

### Automatizado (E2E)

Playwright no puede operar el diálogo nativo. Las pruebas añaden, solo en el proceso de prueba, un listener `will-download` que llama a `setSavePath` después del listener del producto:

| Caso | Resultado |
|---|---|
| Descarga de 2 MB con progreso | el snapshot expone recuento, bytes y estado; el nombre y la carpeta no aparecen en snapshots, archivos de `userData`, stdout/stderr del proceso principal ni consola del shell, y no se muestra ningún aviso |
| Cerrar el browser durante la descarga | `cancelled` y el archivo parcial se elimina |
| Mover un browser Private a un perfil persistente durante la descarga | `cancelled` y el parcial se elimina |
| Salir de la app con una descarga activa | la descarga se interrumpe y el parcial se elimina |
| Perfil Private con cookie, `localStorage`, `sessionStorage`, IndexedDB, título, URL y una descarga completada | tras salir, y tras un segundo arranque y salida, ni el token, ni los nombres de archivo, ni la carpeta aparecen en `userData` (búsqueda UTF-8 y UTF-16LE); el control persistente sí aparece en `workspace.json`. El archivo aceptado sigue en la carpeta elegida |

No existe una acción para cerrar un perfil Private en runtime; se cierra al salir de la app.

### Diálogo nativo sin respuesta (sonda sin control de UI)

Bundle de producción con el binario `electron` de desarrollo, de ahí el prefijo `com.github.Electron` del temporal:

| Observación | Resultado |
|---|---|
| Ruta del item mientras el diálogo espera | vacía; estado `progressing` |
| Archivo temporal | `~/Downloads/.com.github.Electron.XXXXXX` con 4 561 323 bytes unos 1.5 s después de empezar |
| Snapshot | solo agregados (1 activa, bytes recibidos y totales, estado), sin ruta ni nombre |
| Salir con el diálogo abierto | proceso terminado en 353 ms, descarga abortada y temporal eliminado; sin nombre ni ruta en la salida ni en `workspace.json` |

Código: `ElectronDownloadManagerDelegate` solo fija el destino cuando se cierra el diálogo y, mientras tanto, `BaseFile::Initialize` de Chromium crea el temporal en el directorio de descargas por defecto (`DIR_DEFAULT_DOWNLOADS`). Según ese código, al guardar el temporal se renombra al destino y al cancelar se elimina; los clics no se pudieron verificar (abajo). Un cierre forzado o un crash con el diálogo abierto puede dejar el temporal. Mitigarlo para Private (pausar el item hasta tener destino o cambiar el directorio por defecto) altera la robustez de descargas largas y la experiencia del diálogo, por lo que queda como decisión de producto. El aviso existente sigue siendo cierto: los archivos aceptados permanecen después de cerrar el perfil Private.

### Bloqueado

Pulsar **Guardar** y **Cancelar** en el diálogo nativo (perfil persistente y Private) requiere control de la UI, que no se autorizó en esta sesión. Protocolo en [qa-inventory.md](qa-inventory.md).

## 9. Auditoría funcional

| Área | Cobertura y resultado |
|---|---|
| Proyección persistente sin Private | unitarias de modelo; E2E de reinicio y nueva E2E de rastros en disco |
| Zona, perfil y stack; limpieza al borrar o desagrupar | unitarias de integridad y validación de esquema; E2E de zonas colapsadas y stacks |
| Fullscreen, Escape dentro del contenido nativo y restauración de geometría | E2E existente (Escape enviado a la página) |
| Bloqueo en renderer y modelo | E2E existentes de bloqueo y selección múltiple; unitaria de commits rechazados |
| Selección múltiple desde headers, marquesina y contenido nativo | E2E existente de headers y nueva E2E de marquesina y Shift dentro de la página (H-17) |
| Oclusión frente a headers, minimapa, avisos, menú y etiquetas de zona | E2E existente; nuevas E2E de menú de tarjeta y de etiqueta de zona tras pan (H-15). Sin E2E específica para badges |
| Favicons | unitarias de la caché de favicons |
| Avisos de error Private sin URL, título ni dominio | E2E existente |
| Restauración de sesión y migración V1 → V2 | unitarias de migración y copia de recuperación V1; las E2E de regresión arrancan desde workspaces V1 sembrados, salvo la de etiqueta de zona (V2) |
| Zoom semántico y "Localizar" | E2E sin número fijo de clics |

## 10. Verificación final

Ejecutada en orden el 2026-09-17 entre las 08:37 y las 08:40 UTC, con Node 24.21.0, npm 11.19.0 y `SDKROOT` exportado:

| Comando | Resultado |
|---|---|
| `npm ci` | 921 paquetes en 7 s; `package-lock.json` con el mismo SHA-256 antes y después |
| `npm run verify` | typecheck y lint sin errores; 112 unitarias en 15 archivos |
| `npm run test:poc` | 5/5 POC. El de canvas usó captura del shell (la terminal no tiene permiso de grabación de pantalla) y comprobó la vista seleccionada a través de su página; `docs/poc-results/canvas-arm64.png` conserva su SHA-256 |
| `npm run package` | pasa |
| `npm run test:e2e:only` | 33/33 en 52.2 s |
| `npm run test:perf` | 10/10 observaciones (sección 7) |
| `npm run bench`, dos veces | pasa (7.5) |
| `npm run make` con `OMNIBROWSER_OUT_DIR` temporal | DMG de 126 380 669 bytes y ZIP de 127 076 660 bytes. `codesign --verify --deep --strict` válido en el `.app`, en el ZIP extraído con `ditto` y en el DMG montado; `CFBundleIdentifier` `org.omnibrowser.desktop`, `LSMinimumSystemVersion` 13.0 y los 7 fuses que exige CI en su estado |
| `npm audit --omit=dev --json` | 0 vulnerabilidades |
| `npm audit --json` | 4 altas: `image-size` y sus dependientes `appdmg`, `electron-installer-dmg` y `@electron-forge/maker-dmg` |
| `git diff --check` | sin salida |
| Marcadores `TODO`, `FIXME`, `XXX`, `HACK` | ninguno en archivos versionados ni nuevos |
| Tras la corrección H-19: `npm run verify` y `npm run test:poc` | 112 unitarias y 5/5 POC; la ejecución no dejó directorios temporales nuevos |

Comprobaciones manuales exigidas:

| Comprobación | Estado |
|---|---|
| Matriz arm64 | automatizada completa en este equipo; la parte física (trackpad, diálogo) está bloqueada, ver abajo |
| Matriz Intel/x64 | **bloqueada**: no hay Mac Intel ni Rosetta. CI la ejecutará en `macos-15-intel` al publicar la rama |
| Trackpad sobre browser activo e inactivo | **bloqueada**: control de UI no autorizado. Cubierta por POC y E2E con rueda sintética |
| Gesto horizontal | no aplica: no se habilita (sección 6) |
| Diálogo de descarga, perfil persistente y Private | **bloqueada** para los clics; automatizado con `setSavePath` y con la sonda del diálogo sin respuesta (sección 8) |
| Fullscreen y Escape dentro del contenido nativo | automatizada (E2E); pendiente con teclado real |
| Minimapa, zonas colapsadas, stacks y pins | automatizada (E2E); revisión visual humana pendiente |
| Restauración V1 → V2 | automatizada (unitarias y E2E) |
| Reinicio sin rastros Private | automatizada (E2E de rastros en `userData`) |

## 11. Riesgos residuales

- **x64 e Intel:** sin ejecución local. CI cubrirá POC y E2E en `macos-15-intel` al publicar la rama. La matriz física de trackpad sigue pendiente, aunque no bastaría para publicar los gestos.
- **Diálogo nativo:** Guardar y Cancelar pendientes de validación humana.
- **Pantallas de CI:** la hipótesis del recorte se apoya en issues de `actions/runner-images` y en el mecanismo reproducido, pero debe confirmarse con la resolución registrada y las trazas de la próxima ejecución.
- **Retención de vistas (H-14)** y **temporal previo al diálogo (H-16):** requieren decisión de producto.
- **`image-size` en `appdmg`:** excepción documentada con condición de retirada.
