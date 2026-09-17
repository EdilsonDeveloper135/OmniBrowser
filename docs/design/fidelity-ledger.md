# Ledger de fidelidad visual

## Fuente de concepto

- Archivo: [`omnibrowser-primary-screen.png`](omnibrowser-primary-screen.png)
- Método: generado con ImageGen a partir del brief cerrado del MVP; después se fijaron tokens en [`README.md`](README.md).
- Tamaño nativo: 1586×992 px.
- Rol: contrato visual de composición, no captura de funcionalidad ni asset incluido en runtime.

## Evidencia implementada revisada

| Captura | Viewport CSS | Tamaño Retina |
|---|---:|---:|
| [`implementation-primary-arm64.png`](implementation-primary-arm64.png) | 1440×900 | 2880×1800 |
| [`implementation-minimum-window-arm64.png`](implementation-minimum-window-arm64.png) | 1040×680 | 2080×1360 |
| [`implementation-semantic-zoom-arm64.png`](implementation-semantic-zoom-arm64.png) | 1440×900 | 2880×1800 |

Las tres fueron generadas por Playwright contra el bundle Webpack de producción y revisadas visualmente a resolución original el 2026-09-16.

## Comparación

| Área | Concepto | Implementación | Resultado |
|---|---|---|---|
| Shell | graphite frío con separadores sutiles | `#0b1118`/`#101720`, bordes cool-gray | alta fidelidad |
| Rail | marca, perfiles y acción inferior | árbol sincronizado de fijados, perfiles, zonas, stacks y browsers; búsqueda, contadores y estados compactos | contrato ampliado |
| Toolbar | navegación, URL, CTA azul, zoom, guardado | la navegación vive en el header activo; el toolbar global controla crear, snap, cámara, zoom y guardado | contrato actualizado |
| Canvas | grid punteado de baja intensidad | grid escalado con pan/zoom y coordenadas | alta fidelidad |
| Tarjetas | chrome compacto, identidad de perfil y foco azul | inactiva muestra dominio; activa muestra navegación/URL/acciones; `WebContentsView` respeta header, handles y overlays | alta fidelidad estructural |
| Z-order | ventanas solapadas, una seleccionada | solapamiento real y re-add de vista nativa | verificado |
| Minimap/status | esquina inferior y barra de estado | misma posición, viewport y selección; accesible por teclado | alta fidelidad |
| Reposo/zoom | tarjeta durmiente y composición completa | suspensión real; por debajo de 50 % cambia a tarjetas semánticas | comportamiento ampliado |
| Organización | no representada | zonas colapsables, stacks, minimize, lock, pins, selección múltiple y full screen reversible | ampliación funcional |
| Ventana mínima | no representada | 1040×680 sin scroll ni regiones fuera del viewport | verificado adicional |

## Diferencias de copy

El concepto usa contenido ficticio de correo, calendario y notas para comunicar intención. Las capturas implementadas muestran fixtures deterministas (`READ`, `Reload`, `about:blank`) porque la evidencia debe demostrar sesión compartida, aislamiento y restauración sin depender de servicios externos. El copy de producto —OmniBrowser, perfiles, Perfil, Abrir navegador, Guardado, estado del canvas— se conserva.

## Desviaciones conscientes

- Las tarjetas nuevas nacen en cascada y el E2E fuerza solapamiento, por lo que la captura principal es más densa que el concepto editorial.
- El modo semántico se captura después de un pan intencional; algunas tarjetas quedan parcialmente recortadas y el minimapa revela su posición. Esto valida canvas no acotado, no un layout de marketing.
- El área Chromium reserva 16 px laterales/inferiores y 38 px superiores dentro de la tarjeta para impedir que la superficie nativa cubra los handles React.
- Los perfiles “Temporal” del concepto se sustituyen por Private y por el copy explícito de privacidad local; el estado no durable tampoco aparece en el workspace V2.
- La barra global de URL del concepto deja de ser contrato: cada browser activo posee su navegación y los inactivos reducen el ruido visual al dominio.
- El contenido web real no se escala como una textura: Chromium recibe bounds nuevos y hace reflow. Offscreen rendering queda fuera del MVP.
- El POC de canvas no pudo capturar la composición de superficies nativas sin permiso de Screen Recording en macOS; los E2E sí conservan capturas del shell y los checks de bounds/interacción.

No se detectaron regiones esenciales fuera del viewport, avisos técnicos visibles ni regresiones de CSP en las capturas finales.
