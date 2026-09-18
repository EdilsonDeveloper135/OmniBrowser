# Changelog

Todos los cambios relevantes de OmniBrowser se documentarán en este archivo. El proyecto sigue [Semantic Versioning](https://semver.org/) a partir de su primera release pública.

## [Unreleased]

### Added

- Un agente Browser Use por tarjeta ([ADR 0005](docs/adr/0005-card-scoped-browser-use-agents.md)): panel de chat dentro de la tarjeta, cola privada de hasta 20 instrucciones, Pausar/Reanudar/Detener, reanudación de tareas interrumpidas con su progreso, contexto de la conversación para las instrucciones de seguimiento y proveedor OpenAI-compatible con clave cifrada.
- Sidecar Python congelado con PyInstaller (`npm run agent:build`), pruebas de su protocolo (`npm run agent:test`) y traza de compatibilidad CDP con la versión fijada de Browser Use (`npm run agent:compat`).
- E2E de una tarea completa del agente con el sidecar congelado y un modelo local.

### Fixed

- Un workspace ilegible o de un esquema más reciente ya no se sobrescribe: se conserva y se avisa con el nombre del archivo.
- Una URL remota de más de 4096 caracteres ya no impide guardar el workspace.
- La actividad continua de una página (por ejemplo, un título que cambia) ya no impide guardar.
- La app arranca aunque la página seleccionada no cargue, y los fallos de carga ya no dejan flujos a medias.
- Las vistas Chromium siguen el pan del canvas y ya no cubren la cabecera de tarjetas superiores, el minimapa ni los avisos.
- Suspender, cerrar o reasignar una tarjeta ya no borra las tarjetas abiertas desde ella.
- Cmd+Q, cerrar la sesión y `SIGTERM` terminan la app después de guardar.
- Hacer clic dentro de una página selecciona su tarjeta.
- Una página caída se oculta y ofrece "Recargar".
- El orden z se mantiene denso y ya no puede crecer hasta invalidar el esquema.
- Los errores de entrada se muestran en español, sin JSON de Zod ni stacks en el proceso principal.
- El panel de perfil conserva el nombre si la creación falla.
- El zoom de los botones escala sobre el centro sin error acumulado.
- Los avisos producidos mientras el shell arranca, como el fallo de carga de la página restaurada o la recuperación del workspace, ya no se pierden.
- Después de desplazar o hacer zoom, una vista Chromium ya no cubre etiquetas de zona, chips de zonas colapsadas ni el menú de una tarjeta.
- Shift+clic dentro de una página añade o quita su tarjeta de la selección múltiple.
- La preferencia de historial por gesto ya no se puede activar por IPC ni desde un workspace editado mientras el gesto no esté publicado.
- `npm run test:poc` ya no sobrescribe la evidencia versionada del canvas ni deja perfiles Chromium en el directorio temporal cuando los POC pasan.

### Security

- La pasarela CDP de cada agente aplica la allowlist de navegación de la tarjeta a `Page.navigate` (que no emite `will-navigate`) y el runtime detiene cualquier navegación iniciada por el navegador hacia otro esquema; también deniega `Page.close`, `Page.crash`, el borrado del historial y `Network.loadNetworkResource`.
- La clave del proveedor de IA solo se envía al origen para el que se guardó.
- Se conserva la lista por defecto de clases USB protegidas.
- Los diálogos de protocolo externo tienen límite y enfriamiento, y se activa `safeDialogs`.
- Hay bloqueo de instancia única y `userData` separado para desarrollo.
- El shell empaquetado recibe una cabecera CSP sin WebSocket, y la CSP de desarrollo ya no incluye `unsafe-eval`.
- Hay guardia global para `window.open` y `<webview>`; se rechazan symlinks y archivos no regulares en el workspace, y los backups se escriben de forma atómica.
- Los overrides `tar@7.5.22`, `tmp@0.2.7` y `uuid@11.1.1` (en `sockjs`) eliminan el aviso crítico del toolchain; las excepciones restantes están documentadas.
- `webpack-dev-server` 5.2.6, limitado al plugin webpack de Forge, corrige 6 avisos moderados del servidor de desarrollo, que además escucha solo en `localhost`.
- `@electron/packager` extrae Electron con `@electron-internal/extract-zip@1.0.5` en lugar de `extract-zip@2.0.1`, con las fechas de archivo restablecidas tras extraer; el `.app` resultante es idéntico. `npm audit` completo baja de 22 a 4 avisos, todos de la excepción documentada de `image-size` en el maker DMG.

### Changed

- Los agentes capturan la página aunque su tarjeta esté fuera de pantalla, tapada, minimizada o con la ventana oculta, sin que la página observe un cambio de visibilidad; sus clics no seleccionan ni elevan la tarjeta, y el modelo recibe la URL y el título actuales tras cada navegación.
- `npm run package` copia el sidecar de la arquitectura empaquetada y explica cómo construirlo si falta; el CI construye y verifica el sidecar.
- La prueba del proveedor usa el límite de salida que Browser Use aplica en cada paso (4096 tokens) y espera hasta 60 s: acepta modelos de razonamiento detrás de routers OpenAI-compatibles y explica si el modelo agota el límite o devuelve solo su razonamiento.
- Las capturas del agente reintentan los frames que Chromium pierde mientras una navegación cambia de superficie (`UnknownVizError`), y la respuesta final del agente llega en el idioma de la instrucción.
- El proveedor del agente ya no depende del llavero de macOS. «Recordar la clave en este Mac» (activado por defecto) avisa antes de guardar de que macOS pedirá la contraseña del Mac y de que la recibe macOS, no OmniBrowser. Si se desmarca, o si macOS deniega el acceso, la clave se usa solo durante la sesión sin escribirse en disco, el diálogo explica cómo guardarla después, y la URL y el modelo se recuerdan.
- El llavero ya no se lee al arrancar, solo cuando una tarea o una prueba necesita la clave: macOS deja de pedir la contraseña en cada inicio de un build nuevo, y una denegación ya no aparta `agent-provider.json` como si estuviera corrupto ni hace fallar una tarea tras otra.
- `npm run package:test` escribe en `out/test-stub/`: el paquete de E2E, que no puede ejecutar agentes, ya no reemplaza la aplicación real de `out/`. En desarrollo, sin `npm run agent:build`, el chat del agente pide construir el runtime en lugar de probar el Python del sistema.
- Los bundles de producción se minifican y ya no incluyen source maps.
- Menos IPC, `setBounds` y escrituras durante la actividad de las páginas y las interacciones del canvas.
- Pan y zoom del canvas por teclado.
- Nuevas suites `runtime-regressions` (E2E) y `test:perf` (observaciones de rendimiento).
- Con 500 tarjetas, el shell gasta un 68–73 % menos de script al arrastrar, al panear con la rueda y ante los eventos de las páginas, y el p95 de frames baja de 16.5–16.8 ms a 9.2–10.3 ms en la máquina de referencia.
- Nuevo POC `gesture-interception-gate`, `npm run bench` y métricas de frames, hilo principal y CPU del shell en `test:perf`.
- Las E2E fijan su ventana de 1440×900 aunque la pantalla del runner sea menor; CI registra la resolución y sube las trazas cuando fallan.

### Pendiente

- firma con Developer ID y notarización de los artefactos distribuibles;
- validación manual de OAuth de terceros con cuentas de prueba autorizadas;
- política de actualización y soporte posterior al MVP;
- matriz física de trackpad en Apple Silicon e Intel y validación manual del diálogo de descarga;
- decisión de producto sobre suspensión automática de vistas ocultas y sobre el archivo temporal que Chromium escribe antes de que se responda el diálogo de descarga.

## [0.1.0] - 2026-09-16

### Added

- shell React local y múltiples tarjetas Chromium basadas en `WebContentsView`;
- perfiles persistentes compartidos y perfiles temporales efímeros;
- canvas con pan, zoom, solapamiento, orden visual, movimiento y redimensionamiento;
- URL global, atrás, adelante, recarga, suspensión y reactivación;
- adopción de popups como tarjetas del mismo perfil;
- persistencia atómica y restauración perezosa de workspace e historial sanitizado;
- políticas de permisos, navegación, descargas, protocolos externos e IPC deny-by-default;
- fuses de Electron, empaquetado `.app`, DMG y ZIP para macOS;
- POC deterministas de almacenamiento, canvas, popups y recursos;
- tests unitarios, integración Electron, E2E y matriz CI arm64/x64;
- documentación de arquitectura, decisiones, seguridad, privacidad, QA y releases.

[Unreleased]: https://github.com/EdilsonDeveloper135/OmniBrowser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EdilsonDeveloper135/OmniBrowser/releases/tag/v0.1.0
