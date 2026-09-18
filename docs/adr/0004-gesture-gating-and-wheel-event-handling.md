# ADR 0004: Política de compuerta de gestos y gestión de eventos de rueda no cancelables

- Estado: aceptado para el MVP
- Fecha: 2026-09-17
- Decisores: mantenedores de OmniBrowser

## Contexto

En una interfaz de navegación espacial sobre macOS, los usuarios esperan interactuar mediante gestos naturales de trackpad y rueda de ratón:
1. Desplazamiento con dos dedos para navegar por el lienzo infinito (pan).
2. Desplazamiento con dos dedos dentro de una página web para recorrer su contenido vertical u horizontal.
3. Deslizamiento horizontal (swipe) con dos o tres dedos para navegar Atrás y Adelante en el historial.

Sin embargo, la composición de vistas nativas `WebContentsView` en Chromium / Electron 44.4.1 impone una restricción técnica insoslayable a nivel de arquitectura:
- **No cancelabilidad de eventos de rueda:** En Electron 44, los hooks del proceso principal no pueden interceptar ni cancelar eventos de rueda antes de que alcancen el motor Blink.
  - `before-mouse-event` solo procesa pulsaciones (`kMouseDown` a `kContextMenu`).
  - `before-input-event` solo procesa eventos de teclado.
  - `input-event` permite observar eventos como `mouseWheel` y `gestureScrollBegin/Update/End`, pero sin posibilidad de llamar a `preventDefault()` o detener su propagación a la página web.
  - `CanOverscrollContent()` reporta `false` de forma fija para `WebContentsView`.
- **El riesgo crítico del "doble scroll":** Si OmniBrowser intentase interceptar el desplazamiento sobre una tarjeta inactiva para mover el canvas, la vista nativa recibiría igualmente el evento nativo del sistema operativo, provocando que tanto la página web como el canvas se desplacen simultáneamente. Esto genera una experiencia errática, mareos visuales y pérdida del punto de lectura.

## Decisión

### 1. Política de prioridad local estricta
- **Rueda sobre una tarjeta Chromium (activa o inactiva):** Desplaza exclusivamente el contenido de la página web situada bajo el cursor. La cámara, la posición de las tarjetas y la selección del canvas permanecen inalteradas.
- **Rueda sobre área vacía del canvas:** Realiza paneo del lienzo en los ejes X e Y según los deltas recibidos.

### 2. Mecanismos alternativos de navegación en el canvas
Para garantizar la total maniobrabilidad del canvas sin colisionar con las tarjetas:
- Paneo mediante **Barra espaciadora + arrastre con ratón o trackpad** (`Space + drag`), disponible en cualquier punto de la ventana.
- **Minimapa interactivo** en la esquina inferior para arrastrar el marco del viewport con visualización global.
- **Navegación completa por teclado:** Teclas de flechas para paneo paso a paso (con `Shift` para pasos amplios), `+` y `-` para zoom escalonado, y `0` para restablecer al 100 %.

### 3. Compuerta cerrada para gestos de swipe y pan inactivo
- La funcionalidad de navegación por swipe horizontal (Atrás/Adelante) y el pan sobre tarjetas inactivas se mantienen detrás de una compuerta arquitectónica estricta.
- El esquema Zod del contrato IPC rechaza explícitamente cualquier valor distinto de `historySwipeEnabled: false`.
- El deserializador de `WorkspaceModel` normaliza forzosamente a `false` cualquier preferencia cargada de versiones anteriores o archivos modificados externamente.

### 4. Vigilancia automatizada continua (`gesture-interception-gate`)
- Se implementa el POC automatizado `tests/poc/gesture-interception-gate.ts` (`npm run test:poc:gestures`).
- Este test sintético valida en cada ejecución de CI y actualización de dependencias que Electron sigue sin permitir la cancelación de rueda antes del scroll.
- Si una versión futura de Electron introduce APIs de interceptación cancelable de scroll (`before-wheel-event` o soporte de overscroll nativo), el test fallará de forma intencional, alertando al equipo para evaluar la reapertura de la compuerta.

## Consecuencias

### Positivas
- Ausencia total de doble desplazamiento inesperado o pérdida de control visual.
- Comportamiento consistente y predecible: una página web bajo el cursor siempre responde a la rueda exactamente igual que en un navegador de escritorio nativo.
- Accesibilidad universal garantizada a través del teclado, minimapa y Space+drag.

### Costes y limitaciones
- No se dispone de swipe horizontal de dos dedos para retroceder en el historial dentro del área de la tarjeta durante el MVP; la navegación hacia atrás/adelante debe realizarse desde los botones del encabezado de la tarjeta activa.
- Para panear el canvas cuando una tarjeta grande ocupa gran parte de la pantalla, el usuario debe usar Space+drag, el minimapa, el teclado o apuntar a los márgenes vacíos.

## Decisiones arquitectónicas complementarias

- [ADR 0001: Motor Electron, WebContentsView y particiones por perfil](0001-engine-and-profile-model.md)
- [ADR 0003: Composición nativa WebContentsView en ventana única y gestión de oclusores](0003-single-window-canvas-layout-and-native-occlusion.md)
- [Arquitectura general del MVP](../architecture.md)
