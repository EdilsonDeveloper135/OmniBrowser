import { ChevronLeft, ChevronRight, LoaderCircle, Minus, Plus, RotateCw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BrowserSnapshot, WorkspaceSnapshot } from '../../shared/schemas';

interface ToolbarProps {
  browser?: BrowserSnapshot;
  saveStatus: WorkspaceSnapshot['saveStatus'];
  zoom: number;
  onBack: () => Promise<void>;
  onForward: () => Promise<void>;
  onReload: () => Promise<void>;
  onNavigate: (url: string) => Promise<void>;
  onCreateBrowser: () => Promise<void>;
  onZoom: (direction: 1 | -1) => void;
}

export function Toolbar({ browser, saveStatus, zoom, onBack, onForward, onReload, onNavigate, onCreateBrowser, onZoom }: ToolbarProps) {
  const [address, setAddress] = useState(browser?.url ?? 'about:blank');
  const editingBrowserId = useRef<string | null>(null);
  useEffect(() => {
    if (editingBrowserId.current !== browser?.id) setAddress(browser?.url ?? 'about:blank');
  }, [browser?.id, browser?.url]);

  return (
    <header className="top-toolbar">
      <div className="navigation-cluster">
        <button className="icon-button" aria-label="Atrás" disabled={!browser?.runtime.canGoBack} onClick={() => void onBack()} type="button"><ChevronLeft size={18} /></button>
        <button className="icon-button" aria-label="Adelante" disabled={!browser?.runtime.canGoForward} onClick={() => void onForward()} type="button"><ChevronRight size={18} /></button>
        <button className="icon-button" aria-label="Recargar" disabled={!browser} onClick={() => void onReload()} type="button">
          {browser?.runtime.isLoading ? <LoaderCircle className="spin" size={16} /> : <RotateCw size={16} />}
        </button>
      </div>
      <form
        className="address-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (browser) {
            const target = address;
            editingBrowserId.current = null;
            void onNavigate(target);
          }
        }}
      >
        <Search size={15} aria-hidden="true" />
        <input
          aria-label="URL"
          disabled={!browser}
          onBlur={() => {
            editingBrowserId.current = null;
            setAddress(browser?.url ?? 'about:blank');
          }}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={() => { editingBrowserId.current = browser?.id ?? null; }}
          spellCheck={false}
          value={address}
        />
      </form>
      <button className="create-browser-button" onClick={() => void onCreateBrowser()} type="button"><Plus size={16} /> Abrir navegador</button>
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
