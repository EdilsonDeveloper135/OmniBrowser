# Checklist de release macOS

## Código y evidencia

- [ ] La versión y el changelog están actualizados.
- [ ] `npm ci` se ejecuta con Node 24.21.0 y el lockfile no cambia.
- [ ] `npm run verify` pasa.
- [ ] Los cinco POC pasan en arm64 y x64, con captura compuesta del canvas; `docs/poc-results/` solo cambia si la captura se revisó.
- [ ] `npm run test:e2e` pasa en arm64 y x64.
- [ ] `npm audit --omit=dev` no reporta vulnerabilidades runtime.
- [ ] `npm audit` solo contiene las excepciones vigentes de `docs/security-audit.md`, y sus condiciones de retirada se revisaron.
- [ ] `npm run test:perf` y `npm run bench` se compararon con la última observación registrada en la misma máquina.
- [ ] Las compuertas manuales de `docs/qa-inventory.md` (trackpad en Apple Silicon e Intel, diálogo nativo de descarga en perfiles persistente y Private, revisión visual) están ejecutadas o registradas como bloqueo con su motivo.
- [ ] Los gestos que dependen de cancelar la rueda dentro de un `WebContentsView` siguen sin toggle público, salvo nueva evidencia del POC de gestos y de la matriz física.
- [ ] Las capturas de QA se revisaron a 1440×900 y 1040×680.
- [ ] Se verificó manualmente aislamiento Personal/Trabajo con la fixture.
- [ ] Si se prueba OAuth real, se usa una cuenta desechable autorizada y no se guardan credenciales en evidencias.

## Seguridad

- [ ] `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true` en contenido remoto.
- [ ] Los handlers de permiso siguen deny-by-default.
- [ ] Descargas y protocolos no admitidos siguen bloqueados.
- [ ] `npm start` sigue ligado a `localhost`.
- [ ] El preload no expone IPC genérico.
- [ ] Los fuses del binario empaquetado se inspeccionaron.
- [ ] `Info.plist` declara macOS 13.0 mínimo y el bundle ID esperado.
- [ ] Dependencias directas y alertas Dependabot se revisaron.
- [ ] Se revisó `docs/security-audit.md`; cualquier hallazgo de toolchain aceptado tiene justificación y seguimiento.

## Firma y notarización

- [ ] Hay certificado Developer ID Application válido en un keychain de CI protegido.
- [ ] `OMNIBROWSER_MAC_SIGN_IDENTITY` identifica ese certificado; no se usa la firma ad hoc de desarrollo.
- [ ] La identidad, Team ID y credenciales notariales provienen de secretos, nunca del repositorio.
- [ ] Se generan DMG y ZIP arm64/x64 desde runners nativos.
- [ ] `codesign --verify --deep --strict --verbose=2` pasa.
- [ ] `spctl --assess --type execute --verbose=2` pasa.
- [ ] Apple acepta la notarización y el ticket se grapa al `.app`/DMG.
- [ ] Se valida una instalación limpia en macOS 13 y en una versión actual.

## Publicación

- [ ] El tag firmado coincide con `package.json`.
- [ ] Los SHA-256 de cada artefacto se publican.
- [ ] GitHub Release identifica arquitectura, mínimo de macOS y estado de notarización.
- [ ] Las notas no prometen compatibilidad OAuth no comprobada ni cifras universales de RAM.
- [ ] Se enlazan limitaciones conocidas y política de seguridad.

Auto-update no forma parte del MVP. Añadirlo exige otro ADR, canal de firma estable y pruebas de rollback.
