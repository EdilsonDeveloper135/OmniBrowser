# Auditoría de dependencias y hardening

Fecha de la evidencia local: 2026-09-16. Alcance: código y dependencias fijadas para OmniBrowser 0.1.0.

## Resultado operativo

- `npm audit --omit=dev` no reporta vulnerabilidades en dependencias que se empaquetan como runtime de la aplicación.
- El audit completo reporta 33 avisos transitivos del toolchain de desarrollo y empaquetado: 3 bajos, 3 moderados, 26 altos y 1 crítico. Llegan principalmente a través de Electron Forge y `appdmg`; no son dependencias cargadas por las páginas navegadas ni una afirmación de explotabilidad en el artefacto final.
- `npm audit fix` propone cambios incompatibles o regresivos para el árbol fijado. No se ejecuta `--force`: las actualizaciones se harán de forma explícita, repitiendo POC, tests y validación del paquete.
- Dependabot vigila `npm` y GitHub Actions semanalmente. El CI bloquea nuevas vulnerabilidades de runtime mediante `npm audit --omit=dev`.

Esta aceptación es temporal y se limita al MVP. Antes de una release binaria notarizada se deben revisar los advisories concretos, actualizar cuando Forge/appdmg publiquen rutas compatibles y documentar cualquier excepción restante.

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
