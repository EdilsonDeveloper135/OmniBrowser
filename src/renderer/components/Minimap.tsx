import type { BrowserSnapshot, Camera } from '../../shared/schemas';

interface MinimapProps {
  browsers: BrowserSnapshot[];
  camera: Camera;
  viewportSize: { width: number; height: number };
  selectedBrowserId: string | null;
  hidden: boolean;
  onSelect: (browserId: string) => void;
}

export function Minimap({ browsers, camera, viewportSize, selectedBrowserId, hidden, onSelect }: MinimapProps) {
  if (browsers.length === 0) return null;
  const viewportWorld = {
    x: -camera.panX / camera.zoom,
    y: -camera.panY / camera.zoom,
    width: viewportSize.width / camera.zoom,
    height: viewportSize.height / camera.zoom
  };
  const minX = Math.min(viewportWorld.x, ...browsers.map((browser) => browser.worldRect.x)) - 80;
  const minY = Math.min(viewportWorld.y, ...browsers.map((browser) => browser.worldRect.y)) - 80;
  const maxX = Math.max(viewportWorld.x + viewportWorld.width, ...browsers.map((browser) => browser.worldRect.x + browser.worldRect.width)) + 80;
  const maxY = Math.max(viewportWorld.y + viewportWorld.height, ...browsers.map((browser) => browser.worldRect.y + browser.worldRect.height)) + 80;
  const scale = Math.min(144 / Math.max(1, maxX - minX), 88 / Math.max(1, maxY - minY));
  const project = (value: { x: number; y: number; width: number; height: number }) => ({
    left: 8 + (value.x - minX) * scale,
    top: 8 + (value.y - minY) * scale,
    width: Math.max(3, value.width * scale),
    height: Math.max(2, value.height * scale)
  });

  return (
    // Hidden while a visible Chromium surface covers its corner: native views are drawn above React and would block it.
    <div className="minimap" aria-label="Minimapa del canvas" hidden={hidden}>
      {browsers.map((browser) => (
        <button
          aria-label={`Activar navegador: ${browser.title}`}
          className={`minimap-card ${browser.id === selectedBrowserId ? 'is-selected' : ''}`}
          data-minimap-browser={browser.id}
          key={browser.id}
          onClick={() => onSelect(browser.id)}
          style={project(browser.worldRect)}
          type="button"
        />
      ))}
      <span className="minimap-viewport" style={project(viewportWorld)} />
    </div>
  );
}
