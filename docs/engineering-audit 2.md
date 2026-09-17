# Auditoría técnica integral 2026-09

Fecha: 2026-09-16. Alcance: `main` en `fff27f8`, Electron 44.4.1, macOS 27.0 (26A428), Apple M4 Pro arm64. Este documento registra el baseline previo a cualquier cambio, los hallazgos priorizados con su evidencia y el estado de cada corrección. Las cifras de rendimiento son observaciones de esta máquina, no benchmarks universales.

## 1. Baseline previo a los cambios

### Entorno

| Elemento | Valor |
|---|---|
| Node.js activo del sistema | 26.8.1, **no admitido** por el proyecto |
| Node.js usado | 24.21.0 oficial (`SHASUMS256.txt` de nodejs.org coincide; firma Developer ID de Node.js Foundation, HX7739G8FX) |
| npm | 11.19.0 |
| SDK | `SDKROOT=$(xcrun --sdk macosx --show-sdk-path)` → MacOSX26.5.sdk, Xcode en `/Applications/Xcode.app` |
| Volumen | APFS sin distinción de mayúsculas; el repositorio está dentro de un dominio File Provider (`com.apple.fileprovider.fpfs#P`) |

### Comandos

| Comando | Resultado |
|---|---|
| `npm ci` | pasa; lockfile sin cambios |
| `npm run verify` | pasa: typecheck, lint y 19 tests unitarios |
| `npm run test:poc` | pasan los 4 POC |
| `npm run test:e2e` | pasa: paquete + 3 E2E; **reescribe tres PNG versionados de `docs/design/`** |
| paquete | firma ad hoc válida; `CFBundleIdentifier` y `LSMinimumSystemVersion` correctos; los 7 fuses exigidos están en el estado esperado |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `npm audit` | 33 avisos: 3 bajos, 3 moderados, 26 altos y 1 crítico |

`@electron/fuses@1.8.0` muestra `undefined is Enabled` para un fuse que no sabe nombrar. Es un fuse posterior a esa versión de la herramienta que queda en su valor por defecto; no es un fuse de seguridad desactivado.

### Rendimiento antes de cambios

Arnés: `npm run test:perf` (`tests/perf/workspace-performance.spec.ts`), que usa el bundle de producción y un workspace sembrado con tarjetas de 320×260 en rejilla sin solapamiento. Memoria: working set total de todos los procesos, en KiB.

| Tarjetas | Visibles | Ocultas (zoom semántico) | Fuera de viewport | Suspendidas | Una reactivada |
|---:|---:|---:|---:|---:|---:|
| 1 | 555,968 (5 procesos) | 573,024 | 578,160 ¹ | 478,352 (4) | 577,696 (5) |
| 5 | 967,872 (9) | 987,936 | 996,128 ¹ | 494,016 (4) | 593,200 (5) |
| 10 | 1,478,784 (14) | 1,508,608 | 1,520,448 ¹ | 516,576 (4) | 615,920 (5) |

¹ Después del pan las vistas nativas **siguieron visibles** en su posición anterior (hallazgo F-05).

| Escenario | CPU total | `commit-layout` | `setBounds` | `setVisible` | Eventos al shell | Escrituras de `workspace.json` | Error de alineación final |
|---|---:|---:|---:|---:|---:|---:|---:|
| 5 tarjetas estáticas, reposo 5 s | 0.06 % | 0 | 0 | 0 | 0 | 0 | — |
| 5 tarjetas con título cada 100 ms, 5 s | 2.32 % | 152 | 760 | 760 | 250 | **0** | — |
| pan de 40×30 px en 60 frames | 1.14 % | 0 | **0** | 0 | 2 | 1 | **39.6 px** |
| arrastre de una tarjeta, 60 frames | 1.26 % | 61 | 305 | 305 | 2 | 1 | 0.6 px |
| resize de una tarjeta, 60 frames | 1.89 % | 61 | 305 | 305 | 2 | 1 | 0.6 px |

## 2. Hallazgos priorizados

Escala: **P0** pérdida de datos, escape de sandbox, exposición de sesión, ejecución remota o corrupción grave; **P1** función central rota, aislamiento incorrecto o lifecycle peligroso; **P2** comportamiento incorrecto con workaround o degradación notable; **P3** mantenibilidad, UX o rendimiento menor.

Las pruebas empíricas usaron el bundle de producción sin modificar (sondas Playwright y Vitest temporales). El estado final de cada hallazgo se detalla en la sección 4.

### P0

#### F-01 · Un workspace inválido o de versión futura acaba sobrescrito

- **Archivos:** `src/main/persistence/workspace-store.ts:36-82`, `src/main/app-controller.ts:55`.
- **Evidencia:** principal y backup con `schemaVersion: 2` → `load()` devuelve `recoveredFrom: "new"` → dos `save()` → ningún archivo conserva los datos originales.
- **Causa raíz:** la marca para preservar el principal solo se activa si el backup es válido. En la rama `new`, `save()` copia el principal inválido sobre el backup y después lo reemplaza. El aviso "sin borrar los archivos anteriores" es falso a partir del segundo guardado.
- **Impacto:** pérdida total del workspace tras un downgrade, un archivo truncado recuperable a mano o un archivo que supere el límite de tamaño.
- **Reproducción:** escribir `workspace.json` y `workspace.backup.json` con `schemaVersion: 2` y arrancar.
- **Solución:** conservar siempre como `workspace.corrupt-*.json` cualquier principal o backup existente e inválido antes de escribir; tratar una versión futura como no escribible y avisar; migraciones explícitas por versión.
- **Pruebas:** unitarias de store para ambos corruptos, versión futura y límite de tamaño.
- **Riesgo de regresión:** bajo; solo añade archivos preservados.

#### F-02 · Una URL de más de 4096 caracteres bloquea todos los guardados

- **Archivos:** `src/main/browser/browser-runtime.ts:319-355`, `src/main/domain/workspace-model.ts:188-196`, `src/shared/schemas.ts:49,63`.
- **Evidencia:** una página navega a sí misma a `/one?q…` (4227 caracteres) → `saveNow` rechaza con `ZodError` y el estado se queda en `saving`. Unitaria: `setNavigation` acepta la URL y `toPersistentFile()` lanza.
- **Causa raíz:** el historial capturado y `record.url` no se sanean contra los límites del esquema; la validación del archivo completo falla por una sola entrada.
- **Impacto:** contenido remoto (URLs de tracking, SAML u OAuth largas) deja la persistencia inservible y se pierden todos los cambios de la sesión al salir. Además, un workspace mayor de 10 MiB no se puede leer y entra en F-01.
- **Solución:** sanear en captura (descartar entradas no válidas o demasiado largas y reasignar el índice), validar en `setNavigation`, y ajustar el presupuesto de bytes al guardar recortando historial antiguo antes de superar el límite de lectura.
- **Pruebas:** unitarias del modelo y del presupuesto; E2E de URL larga.
- **Riesgo de regresión:** bajo; solo se pierde historial imposible de persistir.

### P1

#### F-03 · Inanición del guardado mientras haya actividad

- **Archivos:** `src/main/lifecycle/save-scheduler.ts:17-24`; disparadores en `browser-runtime.ts:171,335`.
- **Evidencia:** con un título que cambia cada 100 ms, 0 escrituras en 6 s en la app real (ni el workspace inicial) y 0 guardados en 10 s en la unitaria.
- **Causa raíz:** cada `schedule()` reinicia el temporizador de 450 ms sin espera máxima, y cada evento de navegación o layout vuelve a programarlo.
- **Impacto:** ante un cierre forzado o un crash se pierde todo lo hecho desde que una página empezó a emitir eventos.
- **Solución:** espera máxima acotada, programar solo si cambia el contenido persistido y omitir escrituras idénticas.
- **Pruebas:** unitarias con temporizadores falsos; métrica de escrituras en el arnés.
- **Riesgo de regresión:** bajo.

#### F-04 · La app no arranca si falla la carga de la tarjeta seleccionada; los fallos de carga rompen flujos

- **Archivos:** `browser-runtime.ts:69-74,183-214,302-317`, `app-controller.ts:48-57`, `src/main/index.ts:63-71`.
- **Evidencia:** workspace con la URL seleccionada en `http://127.0.0.1:9/` → el proceso termina sin mostrar el shell.
- **Causa raíz:** `createView` espera la carga completa (`restore`/`loadURL` rechazan en `did-fail-load`); el rechazo sube por `initialize()` hasta `app.exit(1)`. Por la misma vía, `createBrowser`, `wake`, `assignProfile` y `applyLayout` fallan después de mutar el modelo y sin emitir snapshot ni guardar.
- **Impacto:** sin red la aplicación no abre. El arranque tarda lo que tarde la página remota. Tras un fallo, la UI puede mostrar un perfil distinto al de la sesión real de la vista.
- **Solución:** la creación de vista termina al adjuntar la vista e iniciar la navegación; el resultado de carga se observa por eventos; el fallback a la última URL no puede pisar una navegación más reciente; el arranque no depende de la red.
- **Pruebas:** E2E de arranque con URL inalcanzable; E2E de reasignación y wake con destino inalcanzable.
- **Riesgo de regresión:** medio (orden de restauración); cubierto por E2E.

#### F-05 · Las vistas nativas no siguen el pan del canvas

- **Archivo:** `src/renderer/components/WorkspaceCanvas.tsx:48-82`.
- **Evidencia:** pan de 40×30 → 0 `setBounds`, error final de 39.6 px; en la sonda, la tarjeta pasa a x=231 mientras la vista sigue en x=291. En la medición de memoria, la vista siguió visible fuera de su tarjeta.
- **Causa raíz:** el efecto depende de `snapshot.browsers`, `camera.zoom` y `selectedBrowserId`, pero no de `panX`/`panY`.
- **Impacto:** contenido web desplazado sobre regiones equivocadas, clics dirigidos a otra zona y vistas visibles fuera del viewport.
- **Solución:** derivar el layout de una clave geométrica completa (cámara, viewport y rectángulos) y enviar solo cambios.
- **Pruebas:** E2E de alineación tras pan por arrastre y rueda.
- **Riesgo de regresión:** bajo.

#### F-06 · Superficies Chromium tapan controles React

- **Archivos:** `WorkspaceCanvas.tsx:59-78`, `browser-runtime.ts:134-139,158-172`, `src/renderer/styles.css:375,387`.
- **Evidencia:** con dos tarjetas en cascada, la vista de la tarjeta inferior (z=1, y 151–466) cubre la cabecera de la superior (y 149–180). Una tarjeta arrastrada a la esquina deja el minimapa (1266,754 160×104) completamente cubierto por una vista visible.
- **Causa raíz:** toda vista nativa se pinta sobre el shell, y la visibilidad solo considera el zoom y la contención en el viewport; no considera la oclusión por tarjetas superiores ni por los overlays del canvas.
- **Impacto:** cabecera, cierre y handles de la tarjeta superior inaccesibles; minimapa y avisos de error invisibles. Las E2E usaban teclado sobre el minimapa para esquivar el problema.
- **Solución:** ocultar la vista de una tarjeta ocluida por el rectángulo exterior de otra con mayor z (mostrando el placeholder React) y aplicar el orden nativo por z. El aviso ocluye mientras está visible; el minimapa cede y se oculta si lo cubre una vista visible.
- **Pruebas:** unitarias de oclusión; E2E de solapamiento, minimapa y aviso.
- **Riesgo de regresión:** medio (cambia qué tarjetas muestran contenido vivo); decisión documentada.

#### F-07 · Suspender, cerrar o reasignar el opener borra las tarjetas popup

- **Archivo:** `browser-runtime.ts:245-253,260-268` (`outlivesOpener: false`).
- **Evidencia:** dos enlaces `target=_blank` (con y sin `rel=opener`) crean 3 tarjetas; al suspender la original quedan 1.
- **Causa raíz:** Electron destruye el hijo cuando se cierra el opener, y el handler `destroyed` interpreta toda destrucción no intencional como cierre del usuario y borra el registro.
- **Impacto:** pérdida silenciosa de tarjetas persistentes por una acción sobre otra tarjeta. Al cerrar la ventana en macOS, la eliminación se persiste con la app aún viva.
- **Solución:** `outlivesOpener: true` (cada tarjeta es de primer nivel; `opener` y `postMessage` siguen vivos mientras existan ambas) y que la destrucción durante `dispose` o suspensión no elimine registros.
- **Pruebas:** E2E de popup con suspensión del opener; POC de popup sin cambios.
- **Riesgo de regresión:** bajo.

#### F-08 · Salir de la app se cancela: el proceso queda vivo sin ventana

- **Archivos:** `app-controller.ts:216-225`, `src/main/index.ts` (sin `before-quit`).
- **Evidencia:** `app.quit()` → a los 8 s el proceso sigue vivo con 0 ventanas; procesos enviados con `SIGTERM` siguen vivos minutos después.
- **Causa raíz:** el `preventDefault()` del evento `close` durante un quit cancela la salida, y tras el apagado solo se cierra la ventana.
- **Impacto:** Cmd+Q, cierre de sesión y `SIGTERM` no terminan la app; un segundo controlador podría escribir sobre el workspace del primero al reactivarse.
- **Solución:** coordinar el apagado en `before-quit`, reanudar `app.quit()` al terminar y hacer idempotente la liberación del controlador (temporizadores y listeners).
- **Pruebas:** E2E de `app.quit()` que termina el proceso y conserva el estado.
- **Riesgo de regresión:** bajo.

#### F-09 · Desarrollo y paquete comparten `userData`, sin instancia única

- **Archivos:** `src/main/index.ts`, `package.json` (`name: omnibrowser`).
- **Evidencia:** `~/Library/Application Support/omnibrowser` y `…/OmniBrowser` tienen el mismo inodo (87674550). No existe `requestSingleInstanceLock`.
- **Causa raíz:** en desarrollo el nombre de la app sale de `package.json` y en el paquete del bundle; APFS no distingue mayúsculas.
- **Impacto:** `npm start` lee y escribe el workspace y las cookies reales. Dos procesos sobre las mismas particiones y el mismo JSON pierden cambios (gana el último en escribir) y compiten por los locks de Chromium.
- **Solución:** `userData` separado cuando `!app.isPackaged` y bloqueo de instancia única que enfoca la ventana existente.
- **Pruebas:** E2E de segunda instancia que termina sin tocar el workspace.
- **Riesgo de regresión:** bajo; en desarrollo se empieza con un workspace nuevo.

### P2

| ID | Hallazgo | Archivo:líneas | Evidencia | Causa raíz → solución | Pruebas |
|---|---|---|---|---|---|
| F-10 | Errores de entrada esperados salen como excepciones IPC con stack en main; la UI muestra JSON Zod crudo | `ipc/register-ipc.ts:12-25`, `app-controller.ts`, `shared/urls.ts` | `Error occurred in handler for 'omni:browsers:navigate': InvalidNavigationUrlError…` más el stack; URL vacía o >4096 → toast con `[{"origin":"string","code":"too_small"…}]` | Los handlers lanzan todo error → sobre de resultado tipado; errores esperados sin stack, mensajes en español | unitarias del mapeo; E2E sin stack en stderr |
| F-11 | Hacer clic dentro de la página no selecciona la tarjeta; la barra actúa sobre otra | `browser-runtime.ts:216-270` | no hay listener de `focus` del `WebContents` | Evento `focus` → seleccionar y elevar | E2E de foco |
| F-12 | Cada cambio de título o carga provoca un commit de layout de todas las tarjetas, `setBounds`/`setVisible` de todas las vistas e IPC con historial completo | `App.tsx:30-35`, `WorkspaceCanvas.tsx:48-82`, `app-controller.ts:194-197`, `workspace-model.ts:208-217` | 152 commits, 760 `setBounds` y 250 eventos en 5 s | Clave geométrica en el renderer, diffs en main y agrupación por tarjeta | arnés de rendimiento |
| F-13 | El handler USB permite **todas** las clases protegidas | `security/security-policy.ts:51` | Docs de Electron 44: devolver `[]` permite todas las clases | Devolver la lista por defecto recibida | unitaria de política |
| F-14 | Diálogos de protocolo externo y `alert()` sin límite bloquean todo el workspace (hoja modal de ventana) | `security-policy.ts:60-78`, `browser-runtime.ts:218-223` | Sin control de concurrencia ni `safeDialogs` | Un diálogo externo a la vez con enfriamiento; `safeDialogs` | E2E con 20 `mailto:` |
| F-15 | Guardado por temporizador: rechazo no manejado y sin reintento; un fallo aborta el resto del apagado | `save-scheduler.ts:20-23,43-46`, `app-controller.ts:177-187` | 1 `unhandledRejection` en la unitaria | Capturar, reintentar con backoff y apagado por pasos independientes | unitarias |
| F-16 | Backup no atómico que copia el principal en disco aunque esté manipulado; temporales huérfanos; lectura sigue symlinks y archivos no regulares | `workspace-store.ts:63-71,86-89` | El backup contiene `{"tampered": true}` | Backup desde el último JSON válido en memoria con escritura atómica; `lstat` y rechazo de no regulares; limpieza de temporales | unitarias |
| F-17 | Eventos de main sobrescriben la geometría local durante el drag; sin pointer capture ni limpieza al desmontar; zoom obsoleto durante el drag | `App.tsx:30-35`, `WorkspaceCanvas.tsx:89-124` | Revisión de código | Fusionar solo campos de navegación, capturar el puntero y leer la cámara por ref | E2E y unitaria de geometría |
| F-18 | Tras un crash del renderer la vista en blanco sigue visible, `crashed` no se reinicia y la tarjeta no ofrece recuperación | `browser-runtime.ts:239-244`, `BrowserCard.tsx:57-63` | Revisión de código | Ocultar la vista y ofrecer "Recargar"; reiniciar al navegar; ignorar `clean-exit` | E2E con `forcefullyCrashRenderer` |
| F-19 | `zIndex` crece sin límite y acaba invalidando el esquema | `workspace-model.ts:138,198-206`, `schemas.ts:62,139` | Cada foco suma 1; tope 1 000 000 | Compactar el orden | unitaria |

### P3

| ID | Hallazgo | Archivo:líneas | Solución |
|---|---|---|---|
| F-20 | Producción sin minificar (`NODE_ENV` al cargar la config nunca vale `production`); CSP de producción con `connect-src ws:` | `webpack.*.config.cjs`, `renderer/index.html:5` | Config función con `mode` de Forge; cabecera CSP estricta desde `omnibrowser://` |
| F-21 | `navigate` sobre una tarjeta suspendida no emite snapshot ni guarda | `browser-runtime.ts:111-117` | Emitir y guardar |
| F-22 | Errores de dominio en inglés en la UI (`Browser … does not exist.`) | `workspace-model.ts:107-117` | Errores de dominio localizados |
| F-23 | El índice restaurado se desplaza si se filtran entradas anteriores | `browser-runtime.ts:304-310` | Remapear el índice |
| F-24 | Los botones de zoom escalan desde el origen y acumulan error flotante; `preventDefault` en un listener de rueda pasivo | `Toolbar.tsx:60-62`, `App.tsx:123`, `WorkspaceCanvas.tsx:132-145` | Zoom sobre el centro redondeado; listener no pasivo |
| F-25 | Sin pan ni zoom del canvas por teclado | `WorkspaceCanvas.tsx` | Flechas y `+`/`-` sobre el canvas enfocable |
| F-26 | El panel de perfil se cierra y pierde el nombre si la creación falla | `ProfileRail.tsx:19-30` | Mantenerlo abierto |
| F-27 | Identificador de aviso por `Date.now()` | `App.tsx:19-23` | Contador |
| F-28 | `flushPersistent` crea sesiones de perfiles nunca usados | `profile-session-manager.ts:34-40` | Vaciar solo las sesiones cacheadas |
| F-29 | Código muerto o incorrecto: `projectWorldRect` ignora los insets reales, `shouldShowNativeView`, `nextZoom`, `minimumBrowserRect` | `shared/geometry.ts:24-49`, `WorkspaceCanvas.tsx:216-218`, `workspace-model.ts:274-281` | Unificar geometría compartida usada por la app |
| F-30 | La E2E reescribe evidencias visuales versionadas en cada ejecución | `tests/e2e/omnibrowser.spec.ts:307,334,377` | Escribir en `test-results/` salvo petición explícita |
| F-31 | Los POC validan primitivas aisladas, no `BrowserRuntime` | `pocs/*` | Pruebas E2E de integración sobre el runtime real |
| F-32 | La documentación dice "completamente fuera"; el código oculta también las tarjetas parcialmente fuera | `docs/architecture.md:80` | Corregir la documentación |
| F-33 | El constructor falla si existe un perfil persistente llamado "Temporal" | `workspace-model.ts:92,125-126` | Nombre temporal único |
| F-34 | `omnibrowser://` no valida el host; `decodeURIComponent` puede lanzar | `protocol/shell-protocol.ts:27-37` | Validar el host y devolver 400 |
| F-35 | Sin guardia global `web-contents-created` | `src/main/index.ts` | Denegar `window.open` y `<webview>` por defecto |
| F-36 | `npm start` reemplaza `.webpack/<arch>` y `test:e2e:only` expira | flujo de desarrollo | Documentar |
| F-37 | Entrada de URL: caracteres de control aceptados; `[::1]:3000` rechazado | `shared/urls.ts:1,11-30` | Rechazar controles; IPv6 entre corchetes |
| F-38 | Avisos de permiso repetidos sin agrupar | `security-policy.ts:45-48` | Deduplicar por ventana temporal |

## 3. Observaciones de runtime investigadas

### `InvalidNavigationUrlError: La entrada no es una URL válida…`

La validación es **correcta**: no hay búsqueda implícita y el renderer muestra el mensaje. Tampoco hay rechazo sin manejar: `ipcMain.handle` captura la excepción y el `run()` del renderer también. El estado de carga no queda mal porque la validación ocurre antes de tocar vista o modelo.

El defecto está en la presentación: Electron registra `Error occurred in handler for 'omni:browsers:navigate'` con el stack completo en el proceso principal por una entrada de usuario esperada, y otras entradas inválidas (vacía o >4096) llegan a la UI como JSON de Zod. Corresponde a F-10.

### `sandbox_extension_issue_file failed … Operation not permitted`

Diagnóstico con evidencia causal:

1. En desarrollo apareció una sola vez en el log unificado (10:52:24, antes de esta auditoría), en `Electron Helper` y a la misma hora e hilo que `Metal Compiling Shader`, para `Electron Helper.app/Contents/Resources`, una ruta **que no existe** en los helpers de Electron. No reapareció en unos 30 lanzamientos posteriores.
2. En el paquete aparecen dos líneas en stdout en cada arranque, con caché fría o caliente: `sandbox_extension_issue_file_to_process failed for …/OmniBrowser.app` y `sandbox_extension_issue_file failed for …/OmniBrowser Helper.app/Contents/Resources`.
3. Persisten con una copia sin atributos extendidos (`ditto --noextattr --norsrc` y `xattr -cr`), firmada ad hoc y verificada con `codesign --verify --deep --strict`, fuera de `Documents` y de File Provider y con otro bundle ID. No dependen de ubicación, iCloud, cuarentena ni firma.
4. `Electron Framework` importa `_sandbox_extension_issue_file`; `sandbox_extension_issue_file_to_process` no está en Electron y sí en AppKit.
5. Al crear `Contents/Resources` vacío en los helpers y volver a firmar, **desaparece** el mensaje del helper y solo queda el de AppKit.

Conclusión: es ruido de plataforma originado por la estructura de helpers que genera Electron (sin `Resources`) y por AppKit en el proceso principal no sandboxed. No afecta la carga de recursos (shell, páginas, cachés GPU, POC y E2E funcionan) y ocurre igual en desarrollo y en el paquete. No se deshabilita ningún sandbox ni se añade al empaquetado un directorio vacío con fines cosméticos.

### Auditoría de dependencias

`npm audit --omit=dev`: 0. Las 33 entradas del audit completo proceden de estas hojas:

| Paquete vulnerable | Cadena exacta | Ámbito | Corrección disponible |
|---|---|---|---|
| `tar@6.2.1` (1 crítico) | `@electron-forge/cli` → `core-utils` → `@electron/rebuild@3.7.2` → `tar` / `@electron/node-gyp` → `tar`, `make-fetch-happen` → `cacache` → `tar` | build (rebuild nativo) | `tar@7.5.22`; los consumidores usan `tar.x`/`tar.extract` con opciones compatibles → override |
| `tmp@0.0.33` | `@electron-forge/cli` → `@inquirer/prompts@6` → `@inquirer/editor` → `external-editor` → `tmp` | CLI interactiva de Forge | `tmp@0.2.7` conserva `tmpNameSync` → override |
| `uuid@8.3.2` | `@electron-forge/plugin-webpack` → `webpack-dev-server@4.15.2` → `sockjs` → `uuid` | servidor de desarrollo | `sockjs` usa `require('uuid').v4`, compatible con `uuid@11.1.1` → override acotado |
| `extract-zip@2.0.1` | `@electron-forge/core` → `@electron/packager@18.4.4` → `extract-zip` | extracción del zip oficial de Electron | no existe versión corregida (2.0.1 es la última) → excepción |
| `image-size@0.7.5` | `appdmg@0.6.6` → `image-size` | maker DMG | la corrección es 2.x, con API incompatible con appdmg (última 0.6.6) → excepción |
| `webpack-dev-server@4.15.2` | `@electron-forge/plugin-webpack@7.11.2` (`^4.0.0`) | servidor de desarrollo | la corrección solo existe en 6.0.0 (5.2.6 sigue afectada); Forge exige ^4 → excepción |

Todos los paquetes `@electron-forge/*` aparecen marcados por transitividad hacia estas hojas. Forge 7.11.2 es la última estable (8.x solo en alpha).

## 4. Correcciones y estado por hallazgo

Las pruebas de regresión E2E (`tests/e2e/runtime-regressions.spec.ts`) se ejecutaron también contra `fff27f8` empaquetado aparte: **13 de sus 15 pruebas iniciales fallan con el código original**, cada una por el defecto que cubre. Las dos que pasan en ambos lados (carreras de wake/sleep/close y orden de restauración) protegen un comportamiento que ya era correcto. Después se añadieron dos pruebas más (teclado y panel de perfil).

| ID | Estado | Corrección | Prueba |
|---|---|---|---|
| F-01 | corregido | preservación `corrupt-`/`future-v<N>-`, aviso con nombre, migraciones explícitas | unit `workspace-store`: ilegibles nunca sobrescritos, esquema futuro, migraciones |
| F-02 | corregido | `sanitizeHistory` en captura, `setNavigation` saneado, presupuesto de bytes al serializar | unit `navigation-history`, `workspace-model`, `workspace-store` (recorte); E2E URL remota > 4096 |
| F-03 | corregido | espera máxima de 2 s, urgencia `idle` y escrituras idénticas omitidas | unit `save-scheduler`; E2E título que cambia; arnés: 0 → 3 escrituras en 5 s |
| F-04 | corregido | runtime síncrono, restauración y carga sin esperar, tokens de navegación, avisos `did-fail-load` | E2E arranque sin red; E2E wake/sleep/close repetidos |
| F-05 | corregido | layout derivado de la cámara y la geometría compartida | E2E alineación ≤ 1 DIP; arnés: 39.6 → 0.4 px |
| F-06 | corregido | `computeCanvasLayout` (oclusión por z, avisos como oclusores), orden nativo por z, minimapa que cede | unit oclusión y minimapa; E2E tarjeta superior, minimapa y aviso |
| F-07 | corregido | `outlivesOpener: true`; sin borrado de registros durante el apagado | E2E popups tras suspender y cerrar el opener |
| F-08 | corregido | apagado idempotente por pasos y `before-quit` que reanuda la salida | E2E `app.quit()`; comprobación manual con `SIGTERM` en desarrollo y en el paquete con fuses (sale en 1 s) |
| F-09 | corregido | `requestSingleInstanceLock`, `userData` `OmniBrowser Development` | E2E segunda instancia |
| F-10 | corregido | `IpcResult`, `parseInput`, `OmniUserError` y mensajes localizados | unit `ipc-result`; E2E entradas inválidas sin ruido en main |
| F-11 | corregido | `input-event` nativo (`mouseDown`/`touchStart`/`gestureTapDown`) → selección y elevación | E2E: la entrada nativa selecciona y un `focus()` programático o `window.focus()` no |
| F-12 | corregido | `LayoutCommitter`, diffs de bounds y visibilidad, sincronización por tarjeta cada 250 ms, snapshots sin historial | unit `renderer-state`; arnés (sección 5) |
| F-13 | corregido | el handler USB devuelve `details.protectedClasses` | unit `security-policy` |
| F-14 | corregido | `ExternalOpenGate` y `safeDialogs` | unit `main-guards`; E2E bucle de `mailto:` (20 → 1 diálogo) |
| F-15 | corregido | fallos capturados, backoff de 1 a 30 s y pasos de apagado independientes | unit `save-scheduler` (sin `unhandledRejection`) |
| F-16 | corregido | backup atómico desde memoria, `lstat`/`O_NOFOLLOW`, limpieza de temporales, `0600` | unit `workspace-store` |
| F-17 | corregido | fusión de snapshots durante gestos, pointer capture, `buttons === 0`, `blur`, limpieza al desmontar, cámara por ref | unit `renderer-state`; E2E alineación tras arrastre |
| F-18 | corregido | vista oculta, botón "Recargar", reinicio en `did-navigate`, se ignora `clean-exit` | E2E crash forzado |
| F-19 | corregido | z-order denso cuya autoridad es main; el layout ya no acepta `zIndex` | unit 5000 focos, paridad con `raiseToTop`, esquema de layout |
| F-20 | corregido | config de Webpack como función de `mode`; cabecera CSP; CSP de desarrollo sin `unsafe-eval`; `<meta>` con `ws://localhost:*` | E2E cabecera, `<meta>` y `connect-src`; bundles 462 → 123 KB y 745 → 247 KB, sin source maps |
| F-21 | corregido | navegar, retroceder, avanzar o recargar una tarjeta suspendida la despierta, guarda y emite snapshot | revisión; sin prueba dedicada |
| F-22 | corregido | `BrowserNotFoundError` y `ProfileNotFoundError` en español | unit `workspace-model` |
| F-23 | corregido | la restauración pasa por `sanitizeHistory`, que remapea el índice | unit `navigation-history` |
| F-24 | corregido | `roundZoom`, zoom centrado y listener de rueda no pasivo | unit zoom; E2E rueda; E2E original (72 %) |
| F-25 | corregido | canvas enfocable: flechas, `+`/`-` y `0` | E2E teclado |
| F-26 | corregido | `onCreate` devuelve éxito; el panel se mantiene abierto | E2E nombre duplicado |
| F-27 | corregido | identificador de aviso por contador | revisión |
| F-28 | corregido | flush solo de sesiones abiertas | revisión; sin prueba dedicada (requiere sesiones reales) |
| F-29 | corregido | se eliminan `nextZoom` y `minimumBrowserRect`; `projectWorldRect` corregido y usado por la app | unit `geometry` (expectativa corregida y caso anclado al DOM) |
| F-30 | corregido | capturas en `test-results/visual/` salvo `OMNIBROWSER_UPDATE_VISUAL_EVIDENCE=1` | `git status` limpio tras las E2E |
| F-31 | corregido | suite E2E sobre el runtime real | 17 E2E nuevas |
| F-32 | corregido | documentación de arquitectura actualizada | — |
| F-33 | corregido | nombre temporal único | unit `workspace-model` |
| F-34 | corregido | `shell-paths.ts` valida host, escapes, NUL y confinamiento | unit `main-guards` |
| F-35 | corregido | `installWebContentsGuards` | E2E `<webview>` inerte sin `WebContents` invitado; la guardia global no se prueba aislada |
| F-36 | documentado | README | — |
| F-37 | corregido | rechazo de caracteres de control; IPv6 entre corchetes; IDN | unit `urls` |
| F-38 | corregido | avisos idénticos agrupados durante 4 s | revisión; sin prueba dedicada |

### Decisiones de diseño con impacto visible

- **Oclusión en vez de recorte.** Una `WebContentsView` no se puede recortar a formas no rectangulares y encogerla haría refluir la página. Por eso una tarjeta cubierta por otra superior, por un aviso o parcialmente fuera del canvas muestra el placeholder React hasta que se eleva o vuelve a caber.
- **El minimapa cede.** Si fuera él quien ocultase las vistas, una tarjeta grande en la esquina inferior derecha nunca mostraría contenido vivo. Mientras una vista visible lo cubre, el minimapa se oculta.
- **`focusContents`.** Arrastrar o redimensionar una tarjeta mueve el foco de teclado a la página. Seleccionarla desde el minimapa, desde una tarjeta semántica o con el teclado no lo mueve, para no romper la navegación por teclado del shell.
- **`userData` de desarrollo.** Tras este cambio, `npm start` empieza con un workspace vacío. Los datos de desarrollo anteriores siguen en la carpeta compartida con el paquete y no se migran automáticamente.

## 5. Rendimiento después de los cambios

Misma máquina, mismo arnés y mismo Electron. La memoria no cambia de forma material (±1 %), como era de esperar: la arquitectura de procesos no se modificó.

| Tarjetas | Visibles | Ocultas (zoom semántico) | Fuera de viewport | Suspendidas | Una reactivada |
|---:|---:|---:|---:|---:|---:|
| 1 | 550,848 (5) | 567,904 | 572,096 ² | 472,304 (4) | 571,632 (5) |
| 5 | 962,928 (9) | 987,392 | 996,048 ² | 493,792 (4) | 593,408 (5) |
| 10 | 1,471,920 (14) | 1,498,352 | 1,510,640 ² | 507,088 (4) | 607,664 (5) |

² Ahora con 0 vistas visibles, que es lo correcto. Ocultar no libera el working set; suspender sí.

| Escenario | CPU total antes → después | `commit-layout` | `setBounds` | `setVisible` | Eventos al shell | Escrituras | Alineación final |
|---|---:|---:|---:|---:|---:|---:|---:|
| reposo, 5 tarjetas estáticas, 5 s | 0.06 → 0.04 % | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | — |
| 5 títulos cada 100 ms, 5 s | 2.32 → 0.95 % | 152 → 0 | 760 → 0 | 760 → 0 | 250 → 106 | **0 → 3** | — |
| pan, 60 frames | 1.14 → 2.68 % ³ | 0 → 60 | 0 → 300 | 0 → 0 | 2 → 2 | 1 → 1 | **39.6 → 0.4 px** |
| arrastre de 1 tarjeta, 60 frames | 1.26 → 1.31 % | 61 → 60 | 305 → 60 | 305 → 0 | 2 → 2 | 1 → 1 | 0.6 → 0.4 px |
| resize de 1 tarjeta, 60 frames | 1.89 → 1.67 % | 61 → 60 | 305 → 60 | 305 → 0 | 2 → 2 | 1 → 1 | 0.6 → 0.4 px |

³ Antes, el pan no actualizaba ninguna vista (hallazgo F-05). El coste nuevo corresponde a mover las 5 vistas visibles y no es una regresión.

## 6. Verificación final

Entorno: Node 24.21.0 verificado, npm 11.19.0, `SDKROOT` exportado, Apple M4 Pro arm64.

| Comando | Resultado |
|---|---|
| `npm ci` | pasa; lockfile estable |
| `npm run verify` | pasa: typecheck, lint y 85 pruebas unitarias en 12 archivos |
| `npm run test:poc` | pasan los 4 POC |
| `npm run test:e2e` | pasa: paquete + 20 E2E (3 originales sin cambios de aserciones + 17 de regresión); tres ejecuciones completas consecutivas de la suite, 20/20 en cada una |
| paquete | fuses correctos; sin `.map` en el ASAR; arranca con fuses, escribe `workspace.json` en `0600` y sale 1 s después de `SIGTERM` |
| `npm run make` (con `OMNIBROWSER_OUT_DIR` temporal) | DMG y ZIP generados; `codesign --verify --deep --strict` pasa en el `.app`, en el ZIP extraído y en el DMG montado |
| `npm start` | carga desde el dev server con la CSP estricta, sin errores; sale con `SIGTERM` |
| `npm audit --omit=dev` | 0 vulnerabilidades |
| `npm audit` | 22 avisos (1 moderado, 21 altos, 0 críticos); excepciones en `security-audit.md` |

`codesign --strict` sobre `out/` **dentro de este repositorio** falla por `com.apple.FinderInfo` reinyectado por File Provider en los helpers (9 atributos). Es la limitación ya documentada en el README; fuera de File Provider la firma es válida.

## 7. Riesgos residuales y trabajo no realizado

- **x64 no ejecutado localmente.** La matriz de CI arm64/x64 no cambió y no se modificó código dependiente de arquitectura, pero x64 se validará en `macos-15-intel`.
- **OAuth real no probado.** Solo se valida la primitiva de popup y opener.
- **Guardia global, flush de sesiones y agrupación de avisos** sin prueba automatizada dedicada (F-28, F-35 parcial, F-38).
- **Regresión propia detectada en la verificación final y corregida.** La primera versión de F-11 seleccionaba la tarjeta con el evento `focus` del `WebContents`. Una ejecución completa falló dos veces de forma intermitente: se perdió la selección restaurada tras reiniciar y el campo URL quedó con el valor duplicado porque la selección cambió mientras se escribía. En esa prueba no hay interacción, y la única ruta del proceso principal que cambia la selección sin acción del usuario era ese listener. Se sustituyó por `input-event`. La nueva prueba fija el invariante (el foco programático no selecciona; la entrada nativa sí), pero **no reproduce el disparo de forma determinista**: en el arnés, `focus()` programático no emite el evento ni siquiera con el listener antiguo. La estabilidad posterior se verificó con tres ejecuciones completas en verde.
- **Fallo intermitente observado una vez.** La primera ejecución de la E2E original tras el cambio registró una navegación a `/setu` en lugar de `/set`. No se reprodujo en más de diez ejecuciones posteriores de la suite ni en una sonda aislada, y ningún camino de código añade caracteres. La hipótesis es una pulsación real llegando a la ventana de la E2E, que toma el foco, con el equipo en uso. Se mantiene en observación.
- **Avisos de toolchain** sin corrección compatible (sección 3 y `security-audit.md`).
- **Aviso de CSP de Electron en desarrollo.** Persiste aunque las políticas servidas no contienen `unsafe-eval`.
- **`sandbox_extension_issue_file`.** Ruido de plataforma diagnosticado (sección 3); no se modificó el empaquetado.
