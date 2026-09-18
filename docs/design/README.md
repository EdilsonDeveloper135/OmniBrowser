# Especificación visual de OmniBrowser

El concepto de pantalla principal en [`omnibrowser-primary-screen.png`](omnibrowser-primary-screen.png) constituye el contrato visual para el shell del MVP. No se distribuye como una imagen estática de UI; cada control visible, etiqueta, tarjeta y superficie de canvas está implementado como interfaz nativa React/CSS rodeando las vistas nativas de Chromium.

## Sistema de diseño establecido

- **Fondo:** canvas grafito frío (`#0b1118`) con una cuadrícula de puntos de bajo contraste a 24 px.
- **Chrome:** casi negro (`#101720`) con separadores gris frío de 1 px.
- **Superficies remotas:** blanco neutro (`#ffffff`), jamás beige o crema.
- **Acento primario:** azul cobalto (`#1877f2`) para foco, selección y la acción de creación.
- **Perfiles:** Personal azul, Trabajo ámbar, Private violeta; los colores de perfil se mantienen como acentos de identidad, nunca temas globales.
- **Tipografía:** Inter/sans-serif del sistema como fallback, 11–14 px para el chrome de la aplicación, títulos de tarjeta legibles y contenidos.
- **Geometría:** radios de 10–12 px, bordes de 1 px, controles compactos de 32–36 px, sombras nítidas de baja opacidad.
- **Modelo de contenedor:** canvas infinito abierto con un rail de perfiles único y barra de herramientas; las tarjetas de navegador son ventanas móviles, no una cuadrícula rígida de dashboard.
- **Movimiento:** transiciones de 140–180 ms en foco/hover; sin animaciones decorativas; respeto a las preferencias del sistema de reducción de movimiento (`prefers-reduced-motion`).

## Inventario de pantalla principal requerida

- Rail de organización con fijados (Pinned), perfiles/zonas/stacks desplegables, navegadores abiertos, búsqueda y `+ Perfil`.
- Barra de herramientas del canvas con `Abrir navegador`, snap, centrado, zoom y estado de `Guardado`; los controles de URL e historial pertenecen al encabezado del navegador activo.
- Múltiples tarjetas de navegador ubicadas libremente con identidad de perfil y estado de selección.
- Tarjeta en suspensión semántica, minimapa y línea concisa de estado del canvas.
- Marcos/chips de zona, tarjetas minimizadas compactas, selector de stack, barra de selección múltiple, fijados al viewport y pantalla completa inmersiva reversible.
- El contenido nativo de Chromium ocupa exclusivamente el rectángulo interior de cada tarjeta (*content slot*); React gestiona encabezados, tiradores de redimensionado, barras de herramientas y capas superpuestas (*overlays*).
