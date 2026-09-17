import { Focus, Grid2X2, Minus, Plus } from 'lucide-react';
import type { WorkspaceSnapshot } from '../../shared/schemas';

interface ToolbarProps {
  saveStatus: WorkspaceSnapshot['saveStatus'];
  zoom: number;
  snapEnabled: boolean;
  onCreateBrowser: () => Promise<void>;
  onZoom: (direction: 1 | -1) => void;
  onResetCamera: () => void;
  onToggleSnap: () => void;
}

export function Toolbar({ saveStatus, zoom, snapEnabled, onCreateBrowser, onZoom, onResetCamera, onToggleSnap }: ToolbarProps) {
  return (
    <header className="top-toolbar">
      <div className="canvas-toolbar-title">
        <strong>Canvas</strong>
        <span>Espacio local</span>
      </div>
      <button className="create-browser-button" onClick={() => void onCreateBrowser()} type="button"><Plus size={16} /> Abrir navegador</button>
      <div className="toolbar-spacer" />
      <button className={`toolbar-toggle ${snapEnabled ? 'is-active' : ''}`} aria-pressed={snapEnabled} onClick={onToggleSnap} type="button">
        <Grid2X2 size={15} /> Snap
      </button>
      <button className="toolbar-toggle" onClick={onResetCamera} type="button"><Focus size={15} /> Recentrar</button>
      <div className="zoom-control" aria-label="Zoom del canvas">
        <button aria-label="Alejar" onClick={() => onZoom(-1)} type="button"><Minus size={15} /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button aria-label="Acercar" onClick={() => onZoom(1)} type="button"><Plus size={15} /></button>
      </div>
      <div className={`save-indicator is-${saveStatus}`}>
        <span />
        {saveStatus === 'saved' ? 'Guardado' : saveStatus === 'saving' ? 'Guardando' : 'Error al guardar'}
      </div>
    </header>
  );
}
