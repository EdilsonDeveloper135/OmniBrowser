# Changelog

Todos los cambios relevantes de OmniBrowser se documentarán en este archivo. El proyecto sigue [Semantic Versioning](https://semver.org/) a partir de su primera release pública.

## [Unreleased]

### Pendiente

- firma con Developer ID y notarización de los artefactos distribuibles;
- validación manual de OAuth de terceros con cuentas de prueba autorizadas;
- política de actualización y soporte posterior al MVP.

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
