# ADR 0003: Composición nativa WebContentsView en ventana única y gestión de oclusores

- Estado: aceptado para el MVP
- Fecha: 2026-09-17
- Decisores: mantenedores de OmniBrowser

## Contexto

OmniBrowser permite organizar libremente múltiples sesiones y páginas web dentro de un lienzo bidimensional infinito con pan y zoom. 

La arquitectura técnica se enfrenta a un desafío fundamental del subsistema de renderizado de Electron:
1. **Composición de superficies nativas:** Los `WebContentsView` de Electron se dibujan como superficies nativas del sistema operativo (vistas NSView en macOS) posicionadas **por encima de todo el contenido HTML/CSS del `BrowserWindow`**.
2. **Colisión de capas (stacking context):** Ninguna propiedad CSS (`z-index`, `transform`, `opacity`) en el shell de React puede situarse visualmente sobre una superficie `WebContentsView` activa. Si un menú contextual, un diálogo modal, una notificación toast o una barra de herramientas se dibuja en HTML sobre las coordenadas de una tarjeta, la vista nativa de Chromium perfora el DOM y oculta el control de la aplicación.
3. **Sincronización geométrica precisa:** Con 500 o más tarjetas, medir el DOM en cada cuadro de animación para calcular las posiciones provocaría *layout thrashing* continuo y caídas severas de cuadros por segundo.
4. **Bloqueo por diálogos síncronos:** El uso de primitivas del navegador como `window.prompt()` o `window.alert()` congela el bucle de eventos del renderer de Chromium, presenta una apariencia no integrada y no puede interactuar con el pipeline de oclusión.

## Decisión

### 1. Ventana única y fuente de verdad geométrica
- El shell completo de la interfaz vive en un único `BrowserWindow` cargando el protocolo seguro y aislado `omnibrowser://app`.
- Cada tarjeta activa aloja un `WebContentsView` gestionado en el proceso principal por `BrowserRuntime`.
- La fuente de verdad de la posición es puramente matemática en coordenadas mundiales (`worldRect`: `x`, `y`, `width`, `height`).
- El cálculo de coordenadas de pantalla (`content slot`) es una proyección lineal pura:
  ```text
  screenX = viewportX + panX + worldX × zoom
  screenY = viewportY + panY + worldY × zoom
  screenW = worldW × zoom
  screenH = worldH × zoom
  ```
- El content slot resta exactamente los márgenes definidos en el sistema de diseño: 38 px para el encabezado superior, 16 px para los bordes laterales e inferior, y 1 px de contorno. Se redondean los bordes a enteros (`Math.floor`/`Math.round`) para evitar fugas de subpíxeles entre tarjetas contiguas.
- La comparación geométrica se centraliza en la función unificada `sameRect` de [`src/shared/geometry.ts`](../../src/shared/geometry.ts).

### 2. Detección y ocultamiento de oclusores (`.native-occluder`)
- Las vistas nativas se componen con prioridad absoluta. Para evitar que tapen la UI del shell, `computeCanvasLayout` evalúa la visibilidad de cada `WebContentsView`:
  - **Oclusión entre tarjetas:** Si una tarjeta con mayor z-order solapa el content slot de una inferior, la inferior se oculta (`setVisible(false)`). Al hacer clic o seleccionarla, sube al frente y su vista se reactiva.
  - **Oclusión por controles fijos del shell:** Barras de herramientas, notificaciones toast y el minimapa declaran la clase `.native-occluder`. Cualquier vista nativa que intersecte estos elementos se oculta.
  - **Oclusión por controles proyectados en el mundo:** Menús de tarjeta, etiquetas de zona y chips de zonas colapsadas se registran en coordenadas del mundo y se recalculan con la cámara activa.
  - **Oclusión por diálogos modales (`PromptModal`):** Se reemplaza `window.prompt()` por el componente React accesible e integrado `PromptModal`. Este componente porta la clase `.native-occluder` y `data-occluder-type="prompt-modal"`. Cuando se solicita renombrar un perfil, crear una zona o editar un recurso, las tarjetas Chromium que queden detrás del modal se ocultan automáticamente para que el diálogo jamás sea perforado ni oscurecido.

### 3. Pipeline de layout asíncrono y coalescente
- React calcula el layout y lo envía al proceso principal a través de IPC mediante `requestAnimationFrame`.
- Se limita a **como máximo una solicitud de layout en vuelo**: si se generan nuevos cuadros durante un arrastre o zoom mientras el proceso principal procesa el anterior, se descartan los cuadros intermedios y solo se emite el último estado disponible.
- El proceso principal solo invoca `setBounds` o `setVisible` si los nuevos valores difieren de los previamente aplicados a la vista.

### 4. Resiliencia de la interfaz (`ErrorBoundary`)
- Toda la jerarquía de React en [`src/renderer/index.tsx`](../../src/renderer/index.tsx) se encapsula dentro de `ErrorBoundary`.
- Si un componente del shell falla, se captura el error, se aísla y se ofrece una interfaz de recuperación limpia con la acción "Reintentar", evitando pantallas blancas irreversibles sin comprometer la estabilidad del proceso principal.

## Consecuencias

### Positivas
- Interfaz fluida a 60 fps durante pan y zoom en canvas densos.
- Experiencia de usuario impecable: los diálogos modales, menús y barras flotantes nunca son tapados por las páginas web nativas.
- Eliminación de bloqueos sincrónicos en el bucle de eventos mediante `PromptModal`.
- Protección contra caídas del shell gracias a `ErrorBoundary`.

### Costes y compromisos
- Una tarjeta temporalmente ocluida por un diálogo o menú muestra su placeholder React con título y dominio hasta que el oclusor desaparece o la tarjeta recupera el foco.
- No es posible aplicar transparencias intermedias (opacity < 1) o esquinas redondeadas arbitrarias con clipping CSS sobre el contenido web interno del `WebContentsView` en esta versión de Electron.

## Decisiones arquitectónicas complementarias

- [ADR 0001: Motor Electron, WebContentsView y particiones por perfil](0001-engine-and-profile-model.md)
- [ADR 0002: Persistencia atómica en disco y recuperación ante corrupción](0002-atomic-persistence-and-corruption-recovery.md)
- [ADR 0004: Política de compuerta de gestos y gestión de eventos de rueda no cancelables](0004-gesture-gating-and-wheel-event-handling.md)
- [Arquitectura general del MVP](../architecture.md)
