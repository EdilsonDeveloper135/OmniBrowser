import { Hand, Maximize2 } from 'lucide-react';

export function StatusBar({ browserCount }: { browserCount: number }) {
  return (
    <footer className="status-bar">
      <span><Hand size={13} /> Arrastra el espacio para navegar</span>
      <span className="status-separator">·</span>
      <span>{browserCount} {browserCount === 1 ? 'navegador' : 'navegadores'}</span>
      <span className="status-spacer" />
      <span><Maximize2 size={13} /> Tu lienzo, sin límites</span>
    </footer>
  );
}
