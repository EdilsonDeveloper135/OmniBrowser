# Auditoría de dependencias y hardening

Fecha de la evidencia local: 2026-09-17. Alcance: código y dependencias fijadas para OmniBrowser 0.1.0.

## Resultado operativo

Actualizado en la segunda pasada de hardening de 2026-09 ([hardening-2026-09](hardening-2026-09.md)); la pasada anterior está en [engineering-audit](engineering-audit.md).

- `npm audit --omit=dev`: 0 vulnerabilidades en dependencias que se empaquetan como runtime.
- Audit completo: 33 avisos → 22 (primera pasada) → **4** (1 aviso real, `image-size`, más sus 3 dependientes transitivos). Moderados y críticos: 0.
- No se ejecutó `npm audit fix --force`: propone `@electron-forge/cli@6.4.2`, `@electron-forge/plugin-webpack@0.0.2` y `appdmg@0.1.0`, bajadas de versión mayor que no resuelven los avisos y rompen el toolchain de Forge 7.

### Cómo se cuentan los avisos

`npm audit` cuenta paquetes del árbol, no avisos: cada dependiente de un paquete vulnerable aparece como vulnerable "vía" él. Las 22 entradas de la primera pasada eran 3 hojas (`extract-zip`, `image-size`, `webpack-dev-server`) con 10 GHSA y 19 dependientes transitivos (`@electron-forge/*`, `@electron/packager`, `appdmg`, `electron-installer-dmg`).

GitHub mostraba 8 alertas abiertas en `main` porque Dependabot cuenta una alerta por GHSA y manifiesto: 2 altas de `extract-zip` (GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3) y 6 moderadas de `webpack-dev-server`. Las 2 altas de `image-size` (GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq) figuran como `auto_dismissed` por la regla de Dependabot para dependencias de desarrollo de bajo impacto; `npm audit` no conoce ese descarte.

### Overrides aplicados

`package.json` fija versiones exactas en `overrides` después de comprobar que cada consumidor usa una API compatible:

| Override | Consumidor y uso comprobado | Avisos eliminados |
|---|---|---|
| `tar@7.5.22` | `@electron/node-gyp` (`tar.extract` en modo archivo y stream, con `strip`, `filter`, `onwarn` y `cwd`), `@electron/rebuild` (`tar.x`), `cacache` | crítico y altos de `tar`, más `cacache`, `make-fetch-happen`, `@electron/node-gyp` y `@electron/rebuild` |
| `tmp@0.2.7` | `external-editor` (`tmpNameSync`) de la CLI interactiva de Forge | `tmp`, `external-editor`, `@inquirer/*` |
| `sockjs` → `uuid@11.1.1` | `sockjs` (`require('uuid').v4`) del servidor de desarrollo | `uuid`, `sockjs` |
| `@electron/packager` → `extract-zip` = `npm:@electron-internal/extract-zip@1.0.5` | `@electron/packager@18.4.4` (`src/unzip.ts`: `await extract(zipPath, { dir })`, única opción que usa) | 2 GHSA altos de `extract-zip` y los 17 dependientes `@electron-forge/*`/`@electron/packager` |
| `@electron-forge/plugin-webpack` → `webpack-dev-server@5.2.6` | `WebpackPlugin` de Forge 7.11.2: `new WebpackDevServer(options, compiler)`, `start()`, `.server`; opciones `hot`, `devMiddleware.writeToDisk`, `historyApiFallback`, `port`, `setupExitSignals`, `static`, `headers` y las de `forge.config.cjs` | 6 GHSA moderados (todos corregidos en ≤ 5.2.6) y `@electron-forge/plugin-webpack` |

#### `extract-zip` → `@electron-internal/extract-zip`

- **Procedencia.** Paquete de la organización Electron (repositorio `electron/extract-zip`, mantenedores de Electron, publicación con *trusted publishing* y atestación SLSA; integridad del lockfile igual a la del registro). Es el sustituto directo que adoptaron `@electron/packager@20.0.1` (electron/packager#1917) y Forge `8.0.0-alpha.10` (electron/forge#4285), y el que `electron@44.4.1` ya usa en su `install.js`: no añade un paquete nuevo al árbol, solo cambia qué copia usa packager 18.
- **Modelo de amenaza.** Su `SECURITY.md` cubre exactamente este uso: archivos de distribución de Electron verificados por checksum (`@electron/get`) y consumidos a través de paquetes de Electron. Valida contención de rutas y symlinks antes de crearlos.
- **Por qué no se actualiza Forge.** Forge 7.11.2 (última estable) exige `@electron/packager@^18.3.5`; los packager 19/20 que traen la corrección solo los usa Forge 8, que sigue en alpha. Forzar packager 20 bajo Forge 7 cruzaría una versión mayor del peer; el override cambia solo la hoja.
- **Diferencia de comportamiento y compensación.** El extractor restaura las fechas del zip (1980-01-01 en los zips oficiales de Electron). Packager 20.2.0 las restablece después de extraer (electron/packager#1940); `forge.config.cjs` hace lo mismo en `packageAfterExtract`.
- **Evidencia.** Con Node 24.21.0: extraer `electron-v44.4.1-darwin-arm64.zip` con ambos extractores produce árboles idénticos (`diff -r` sin diferencias; 259 archivos, 310 directorios, 14 symlinks). `npm run package` con el extractor antiguo y con el nuevo genera `.app` idénticos en tipo, permisos, tamaño, SHA-256 y destino de symlink de sus 601 entradas, sin ninguna fecha de 1980 tras el hook. `codesign --verify --deep --strict`, `CFBundleIdentifier`, `LSMinimumSystemVersion` y los 7 fuses pasan; `npm run make` genera DMG y ZIP cuyo `.app` es idéntico al empaquetado y cuya firma es válida.
- **Condición para retirar el override y el hook.** Forge estable que dependa de `@electron/packager` ≥ 20.2.0.

#### `webpack-dev-server@5.2.6`

- **Procedencia.** Los seis GHSA (GHSA-9jgg-88mc-972h, GHSA-4v9v-hfq4-rm2v, GHSA-79cf-xcqc-c78w, GHSA-mx8g-39q3-5c79, GHSA-f5vj-f2hx-8m93, GHSA-m28w-2pqf-7qgj) tienen versión corregida ≤ 5.2.6. Forge adoptó 5.2.4 en `main` sin cambios de runtime en el plugin (electron/forge#4274: solo comentarios de lint) y después 5.2.6 (electron/forge#4329); 7.11.2 se publicó antes y aún declara `^4.0.0`.
- **Guía de migración v5 revisada.** Las rupturas (`https`/`http2`, `onBefore/AfterSetupMiddleware`, `proxy` como objeto, `magicHtml`, constructor y `listen`/`close`) no afectan al uso de Forge ni a la configuración del proyecto.
- **Evidencia con `npm start`** (`userData` temporal): el renderer carga desde el servidor con la CSP del proyecto, `Cross-Origin-Opener-Policy`, `nosniff` y el nuevo `Cross-Origin-Resource-Policy: same-origin`; una cabecera `Host` malformada devuelve 403 y el servidor sigue vivo; `/webpack-dev-server/invalidate` y `/open-editor` cross-site devuelven 403; leer `main_window/index.js` como script cross-site devuelve 403; tras cambiar `styles.css` el renderer recarga por el socket (control: sin cambios la conexión no se recrea).
- **Endurecimiento adicional.** Sin `host`, el servidor escuchaba en todas las interfaces (`*:3000`); `forge.config.cjs` lo fija a `localhost` (`[::1]:3000`), que es lo que usa la entrada del renderer.
- **Condición para retirar el override.** Forge estable cuyo `plugin-webpack` declare `webpack-dev-server` ≥ 5.2.6.

La compatibilidad de todos los overrides se verificó además con `npm ci` sobre el lockfile resultante, `verify`, los POC, las E2E, `package` y `make`; los resultados están en [hardening-2026-09](hardening-2026-09.md).

### Excepción restante

| Aviso | Cadena | Motivo de la excepción | Exposición real |
|---|---|---|---|
| `image-size@0.7.5`: GHSA-w3rx-r6r6-pgpr (bucle infinito con ICNS) y GHSA-5p2g-fcmc-qvqq (JXL/HEIF) | `@electron-forge/maker-dmg@7.11.2` → `electron-installer-dmg@5.0.1` (opcional) → `appdmg@0.6.6` → `image-size@^0.7.4` | La corrección llega en `image-size` 2.0.3, que elimina la exportación por defecto y la API `sizeOf(ruta, callback)` que usa `appdmg`; `appdmg` 0.6.6 es la última versión (sin cambios desde 2023) y la rama principal de `electron-installer-dmg` sigue en `appdmg@^0.6.4`. Forzar 2.x rompe `npm run make` | Solo `npm run make`. `electron-installer-dmg` pasa a `appdmg` su `resources/mac/background.png` (integridad fijada por el lockfile) porque el proyecto no configura fondo; `image-size` lo identifica como PNG (658×498). La versión instalada no contiene analizadores JXL/HEIF (GHSA-5p2g no aplica) y el analizador ICNS solo se alcanza con un archivo que empiece por `icns`. El icono de volumen se copia sin analizarse. El peor caso es un proceso de build colgado, no ejecución de código |

Condición para retirar la excepción: una versión de `appdmg`/`electron-installer-dmg` que use `image-size` ≥ 2.0.3, un maker DMG de Forge sin `appdmg`, o la decisión de producto de sustituir el maker DMG (por ejemplo, `hdiutil` directo) asumiendo que el DMG pierde la disposición de iconos y el fondo que hoy genera `appdmg`. Mientras tanto, cualquier cambio que configure `background` o `icon` del DMG debe usar archivos versionados del repositorio.

### Exposición residual del toolchain de desarrollo

`@electron-forge/web-multi-logger` (logs de compilación de `npm start`) escucha en todas las interfaces en el puerto 9000 y Forge no permite configurar su host. No sirve código ni datos de usuario; solo existe mientras `npm start` está en marcha.

## Electronegativity

La versión pública disponible de Electronegativity no analiza completamente Electron 44: su CLI presenta una incompatibilidad de dependencias y su parser no entiende toda la sintaxis TypeScript moderna usada por este proyecto. Una ejecución programática parcial no produjo hallazgos de alta certeza, pero ese resultado **no se considera un pase de seguridad**.

Por eso los controles materiales se verifican directamente:

- TypeScript/ESLint y tests negativos de IPC, URL y esquemas;
- suite de 162 pruebas unitarias y de componentes (con soporte de cobertura nativa `@vitest/coverage-v8` y compatibilidad con Node 24 mediante `@types/node@24`), validando `PromptModal` (`.native-occluder`), resiliencia ante excepciones del renderer con `ErrorBoundary`, confinamiento de rutas en `shell-paths`, y políticas de `main-guards` y `security-policy`;
- inspección de preferencias de cada `WebContentsView` remoto;
- handlers deny-by-default de permisos y descargas;
- `codesign --verify --deep --strict` sobre el `.app` y los artefactos DMG/ZIP extraídos;
- inspección de fuses del ejecutable empaquetado;
- comprobación de `CFBundleIdentifier` y `LSMinimumSystemVersion`;
- revisión manual del modelo de confianza en [`security-model.md`](security-model.md);
- formalización de garantías de seguridad en los registros arquitectónicos [ADR 0001](adr/0001-engine-and-profile-model.md), [ADR 0002](adr/0002-atomic-persistence-and-corruption-recovery.md) y [ADR 0003](adr/0003-single-window-canvas-layout-and-native-occlusion.md).

## Limitaciones de la evidencia

- La firma ad hoc demuestra integridad estructural local, no identidad del editor ni aceptación de Gatekeeper.
- Developer ID, hardened runtime, notarización y `spctl` son gates de una release distribuible y necesitan secretos del mantenedor.
- Un audit de paquetes no sustituye revisión de código, sandbox de Chromium ni respuesta a vulnerabilidades futuras de Electron.
- Los POC prueban las propiedades observadas en las versiones y sistemas registrados; no garantizan el comportamiento de versiones futuras.
