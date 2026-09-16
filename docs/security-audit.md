# Auditoría de dependencias y hardening

Fecha de la evidencia local: 2026-09-16. Alcance: código y dependencias fijadas para OmniBrowser 0.1.0.

## Resultado operativo

Actualizado en la auditoría técnica de 2026-09 ([engineering-audit](engineering-audit.md)).

- `npm audit --omit=dev`: 0 vulnerabilidades en dependencias que se empaquetan como runtime.
- Audit completo antes: 33 avisos (3 bajos, 3 moderados, 26 altos, 1 crítico). Después: 22 avisos (0 bajos, 1 moderado, 21 altos, 0 críticos).
- No se ejecutó `npm audit fix --force`: propone downgrades de Forge a 6.x y de appdmg a 0.1.0.

### Overrides aplicados

`package.json` fija versiones exactas en `overrides` después de comprobar que cada consumidor usa una API compatible:

| Override | Consumidor y uso comprobado | Avisos eliminados |
|---|---|---|
| `tar@7.5.22` | `@electron/node-gyp` (`tar.extract` en modo archivo y stream, con `strip`, `filter`, `onwarn` y `cwd`), `@electron/rebuild` (`tar.x`), `cacache` | crítico y altos de `tar`, más `cacache`, `make-fetch-happen`, `@electron/node-gyp` y `@electron/rebuild` |
| `tmp@0.2.7` | `external-editor` (`tmpNameSync`) de la CLI interactiva de Forge | `tmp`, `external-editor`, `@inquirer/*` |
| `sockjs` → `uuid@11.1.1` | `sockjs` (`require('uuid').v4`) del servidor de desarrollo | `uuid`, `sockjs` |

La compatibilidad se verificó extrayendo con esas llamadas un tarball de cabeceras sintético y resolviendo cada módulo desde su consumidor, además de repetir `npm ci` (lockfile estable), `verify`, los cuatro POC, las E2E, `package`, `make` (DMG y ZIP) y `npm start`.

### Excepciones restantes

| Aviso | Cadena | Motivo de la excepción | Exposición |
|---|---|---|---|
| `extract-zip@2.0.1` (symlinks) | `@electron-forge/core` → `@electron/packager@18.4.4` | 2.0.1 es la última versión publicada y no hay corrección | solo extrae el zip de Electron descargado y verificado por `@electron/get` durante el empaquetado |
| `image-size@0.7.5` (bucle infinito con ICNS/JXL/HEIF) | `@electron-forge/maker-dmg` → `electron-installer-dmg` → `appdmg@0.6.6` | la corrección está en 2.x, con una API incompatible con appdmg; appdmg 0.6.6 es la última versión | solo procesa imágenes del propio proyecto al construir el DMG; el proyecto no configura imágenes de DMG |
| `webpack-dev-server@4.15.2` (exposición de código y CSRF en desarrollo) | `@electron-forge/plugin-webpack@7.11.2` (`^4.0.0`) | la corrección solo existe en 6.0.0 (5.2.6 sigue afectada) y Forge 7.11.2, la última estable, exige ^4 | solo durante `npm start` en localhost; no forma parte del paquete |

Los paquetes `@electron-forge/*`, `@electron/packager`, `appdmg` y `electron-installer-dmg` aparecen marcados solo por transitividad hacia estas tres hojas. Hay que revisar las excepciones cuando Forge 8 sea estable o cuando `@electron/packager`/appdmg publiquen correcciones.

## Electronegativity

La versión pública disponible de Electronegativity no analiza completamente Electron 44: su CLI presenta una incompatibilidad de dependencias y su parser no entiende toda la sintaxis TypeScript moderna usada por este proyecto. Una ejecución programática parcial no produjo hallazgos de alta certeza, pero ese resultado **no se considera un pase de seguridad**.

Por eso los controles materiales se verifican directamente:

- TypeScript/ESLint y tests negativos de IPC, URL y esquemas;
- inspección de preferencias de cada `WebContentsView` remoto;
- handlers deny-by-default de permisos y descargas;
- `codesign --verify --deep --strict` sobre el `.app` y los artefactos DMG/ZIP extraídos;
- inspección de fuses del ejecutable empaquetado;
- comprobación de `CFBundleIdentifier` y `LSMinimumSystemVersion`;
- revisión manual del modelo de confianza en [`security-model.md`](security-model.md).

## Limitaciones de la evidencia

- La firma ad hoc demuestra integridad estructural local, no identidad del editor ni aceptación de Gatekeeper.
- Developer ID, hardened runtime, notarización y `spctl` son gates de una release distribuible y necesitan secretos del mantenedor.
- Un audit de paquetes no sustituye revisión de código, sandbox de Chromium ni respuesta a vulnerabilidades futuras de Electron.
- Los POC prueban las propiedades observadas en las versiones y sistemas registrados; no garantizan el comportamiento de versiones futuras.
