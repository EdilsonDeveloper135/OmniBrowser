# Changelog

Todos los cambios relevantes de OmniBrowser se documentarán en este archivo. El proyecto sigue [Semantic Versioning](https://semver.org/) a partir de su primera release pública.

## [Unreleased]

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

- Se conserva la lista por defecto de clases USB protegidas.
- Los diálogos de protocolo externo tienen límite y enfriamiento, y se activa `safeDialogs`.
- Hay bloqueo de instancia única y `userData` separado para desarrollo.
- El shell empaquetado recibe una cabecera CSP sin WebSocket, y la CSP de desarrollo ya no incluye `unsafe-eval`.
- Hay guardia global para `window.open` y `<webview>`; se rechazan symlinks y archivos no regulares en el workspace, y los backups se escriben de forma atómica.
- Los overrides `tar@7.5.22`, `tmp@0.2.7` y `uuid@11.1.1` (en `sockjs`) eliminan el aviso crítico del toolchain; las excepciones restantes están documentadas.
- `webpack-dev-server` 5.2.6, limitado al plugin webpack de Forge, corrige 6 avisos moderados del servidor de desarrollo, que además escucha solo en `localhost`.
- `@electron/packager` extrae Electron con `@electron-internal/extract-zip@1.0.5` en lugar de `extract-zip@2.0.1`, con las fechas de archivo restablecidas tras extraer; el `.app` resultante es idéntico. `npm audit` completo baja de 22 a 4 avisos, todos de la excepción documentada de `image-size` en el maker DMG.

### Changed

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
