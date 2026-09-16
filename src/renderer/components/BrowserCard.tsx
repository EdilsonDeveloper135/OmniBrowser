import { CircleAlert, GripVertical, Moon, RotateCw, X } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserSnapshot, ProfileRecord, WorldRect } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { profileColor } from '../lib/profile-colors';

interface BrowserCardProps {
  browser: BrowserSnapshot;
  profiles: ProfileRecord[];
  selected: boolean;
  onFocus: () => void;
  onClose: () => void;
  onSleep: () => void;
  onWake: () => void;
  onReload: () => void;
  onAssignProfile: (profileId: string) => void;
  onBeginMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onBeginResize: (direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
}

export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export function BrowserCard({ browser, profiles, selected, onFocus, onClose, onSleep, onWake, onReload, onAssignProfile, onBeginMove, onBeginResize }: BrowserCardProps) {
  const profileIndex = profiles.findIndex((profile) => profile.id === browser.profileId);
  const profile = profiles[profileIndex];
  if (!profile) return null;
  const style = {
    left: browser.worldRect.x,
    top: browser.worldRect.y,
    width: browser.worldRect.width,
    height: browser.worldRect.height,
    zIndex: browser.zIndex,
    '--profile-color': profileColor(profile, profileIndex)
  } as React.CSSProperties;

  return (
    <article className={`browser-card ${selected ? 'is-selected' : ''}`} data-browser-id={browser.id} onPointerDown={onFocus} style={style}>
      <header className="browser-card-header" onPointerDown={onBeginMove}>
        <GripVertical className="drag-grip" size={17} aria-hidden="true" />
        <span className="profile-dot" />
        <select
          aria-label={`Perfil de ${browser.title}`}
          onChange={(event) => onAssignProfile(event.target.value)}
          onPointerDown={(event) => event.stopPropagation()}
          value={browser.profileId}
        >
          {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        </select>
        <span className="card-title-separator">—</span>
        <span className="card-title" title={browser.title}>{browser.title || displayDomain(browser.url)}</span>
        <div className="card-actions">
          <button aria-label={browser.suspended ? 'Reactivar' : 'Suspender'} onClick={(event) => { event.stopPropagation(); if (browser.suspended) onWake(); else onSleep(); }} type="button">
            {browser.suspended ? <RotateCw size={14} /> : <Moon size={14} />}
          </button>
          <button aria-label="Cerrar navegador" onClick={(event) => { event.stopPropagation(); onClose(); }} type="button"><X size={15} /></button>
        </div>
      </header>
      <div className="browser-content-slot" data-browser-content={browser.id}>
        <div className="browser-placeholder">
          {browser.suspended ? <Moon size={30} /> : browser.runtime.crashed ? <CircleAlert size={30} /> : <span className="placeholder-globe" />}
          <strong>{browser.suspended ? 'Navegador en reposo' : browser.runtime.crashed ? 'La vista dejó de responder' : browser.title || 'Nueva página'}</strong>
          <span>{displayDomain(browser.url)}</span>
          {browser.suspended ? <button onClick={onWake} type="button">Activar navegador</button> : null}
          {!browser.suspended && browser.runtime.crashed ? <button onClick={onReload} type="button">Recargar</button> : null}
        </div>
      </div>
      {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeDirection[]).map((direction) => (
        <span
          aria-hidden="true"
          className={`resize-handle resize-${direction}`}
          key={direction}
          onPointerDown={(event) => onBeginResize(direction, event)}
        />
      ))}
    </article>
  );
}

export function resizeWorldRect(start: WorldRect, direction: ResizeDirection, dx: number, dy: number, minimumWidth: number, minimumHeight: number): WorldRect {
  let { x, y, width, height } = start;
  if (direction.includes('e')) width = Math.max(minimumWidth, start.width + dx);
  if (direction.includes('s')) height = Math.max(minimumHeight, start.height + dy);
  if (direction.includes('w')) {
    width = Math.max(minimumWidth, start.width - dx);
    x = start.x + (start.width - width);
  }
  if (direction.includes('n')) {
    height = Math.max(minimumHeight, start.height - dy);
    y = start.y + (start.height - height);
  }
  return { x, y, width, height };
}
