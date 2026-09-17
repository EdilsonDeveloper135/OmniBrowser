import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Copy,
  Expand,
  GripVertical,
  LoaderCircle,
  Lock,
  Menu,
  Moon,
  PanelLeft,
  Pin,
  RotateCw,
  Shrink,
  Unlock,
  Volume2,
  X
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserSnapshot, ProfileRecord, StackRecord, WorldRect } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { profileColor } from '../lib/profile-colors';

interface BrowserCardProps {
  browser: BrowserSnapshot;
  profiles: ProfileRecord[];
  rect?: WorldRect;
  surface?: 'world' | 'pinned' | 'immersive';
  selected: boolean;
  multiSelected: boolean;
  stack?: StackRecord;
  stackBrowsers?: BrowserSnapshot[];
  onFocus: (event: ReactPointerEvent<HTMLElement>) => void;
  onClose: () => void;
  onSleep: () => void;
  onWake: () => void;
  onReload: () => void;
  onStop: () => void;
  onBack: () => void;
  onForward: () => void;
  onNavigate: (url: string) => void;
  onAssignProfile: (profileId: string) => void;
  onBeginMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onBeginResize: (direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
  onToggleMinimized: () => void;
  onToggleLocked: () => void;
  onToggleSidebarPin: () => void;
  onToggleViewportPin: () => void;
  onDuplicate: () => void;
  onFullscreen: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  onSelectStackMember?: (browserId: string) => void;
  onUnstack?: () => void;
}

export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

function Favicon({ browser }: { browser: BrowserSnapshot }) {
  const domain = displayDomain(browser.url);
  return browser.runtime.faviconKey
    ? <img alt="" className="browser-favicon" src={`omnibrowser://app/favicon/${encodeURIComponent(browser.runtime.faviconKey)}`} />
    : <span className="favicon-fallback" aria-hidden="true">{domain.charAt(0).toUpperCase() || '•'}</span>;
}

export function BrowserCard({
  browser,
  profiles,
  rect = browser.worldRect,
  surface = 'world',
  selected,
  multiSelected,
  stack,
  stackBrowsers = [],
  onFocus,
  onClose,
  onSleep,
  onWake,
  onReload,
  onStop,
  onBack,
  onForward,
  onNavigate,
  onAssignProfile,
  onBeginMove,
  onBeginResize,
  onToggleMinimized,
  onToggleLocked,
  onToggleSidebarPin,
  onToggleViewportPin,
  onDuplicate,
  onFullscreen,
  onMenuOpenChange,
  onSelectStackMember,
  onUnstack
}: BrowserCardProps) {
  const profileIndex = profiles.findIndex((profile) => profile.id === browser.profileId);
  const profile = profiles[profileIndex];
  const [address, setAddress] = useState(browser.url);
  const addressEditing = useRef(false);
  useEffect(() => {
    if (!addressEditing.current) setAddress(browser.url);
  }, [browser.url]);
  if (!profile) return null;

  const minimized = browser.presentation === 'minimized' && surface === 'world';
  const movable = !browser.positionLocked && surface !== 'pinned' && surface !== 'immersive';
  const resizable = movable && !minimized;
  const style = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: browser.zIndex,
    '--profile-color': profileColor(profile, profileIndex)
  } as React.CSSProperties;
  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    addressEditing.current = false;
    onNavigate(address);
  };

  if (minimized) {
    return (
      <article
        className={`browser-card minimized-browser-card ${selected ? 'is-selected' : ''} ${multiSelected ? 'is-multi-selected' : ''}`}
        data-browser-id={browser.id}
        onPointerDown={onFocus}
        style={style}
      >
        <header className="browser-card-header minimized-header" onPointerDown={onBeginMove}>
          <Favicon browser={browser} />
          <span className="inactive-domain">{displayDomain(browser.url)}</span>
          {browser.positionLocked ? <Lock aria-label="Posición bloqueada" size={12} /> : null}
          <button aria-label="Restaurar navegador" onClick={(event) => { event.stopPropagation(); onToggleMinimized(); }} type="button"><Shrink size={14} /></button>
        </header>
      </article>
    );
  }

  return (
    <article
      className={`browser-card surface-${surface} ${selected ? 'is-selected is-active' : ''} ${multiSelected ? 'is-multi-selected' : ''}`}
      data-browser-id={browser.id}
      onPointerDown={onFocus}
      style={style}
    >
      <header className="browser-card-header" onPointerDown={surface === 'immersive' ? undefined : onBeginMove}>
        {selected ? (
          <>
            {movable ? <GripVertical className="drag-grip" size={15} aria-hidden="true" /> : browser.positionLocked ? <Lock className="drag-grip" size={13} /> : <Pin className="drag-grip" size={13} />}
            <div className="card-navigation" onPointerDown={(event) => event.stopPropagation()}>
              <button aria-label="Atrás" disabled={!browser.runtime.canGoBack} onClick={onBack} type="button"><ArrowLeft size={14} /></button>
              <button aria-label="Adelante" disabled={!browser.runtime.canGoForward} onClick={onForward} type="button"><ArrowRight size={14} /></button>
              <button aria-label={browser.runtime.isLoading ? 'Detener' : 'Recargar'} onClick={browser.runtime.isLoading ? onStop : onReload} type="button">
                {browser.runtime.isLoading ? <LoaderCircle className="spin" size={13} /> : <RotateCw size={13} />}
              </button>
            </div>
            <form className="card-address-form" onPointerDown={(event) => event.stopPropagation()} onSubmit={submitAddress}>
              <Favicon browser={browser} />
              <input
                aria-label="URL"
                onBlur={() => { addressEditing.current = false; setAddress(browser.url); }}
                onChange={(event) => setAddress(event.target.value)}
                onFocus={() => { addressEditing.current = true; }}
                spellCheck={false}
                value={address}
              />
            </form>
            {stack && stackBrowsers.length > 1 ? (
              <div className="stack-switcher" onPointerDown={(event) => event.stopPropagation()}>
                <span>{stackBrowsers.length}</span>
                <select aria-label="Miembro visible del stack" onChange={(event) => onSelectStackMember?.(event.target.value)} value={browser.id}>
                  {stackBrowsers.map((member) => <option key={member.id} value={member.id}>{member.title || displayDomain(member.url)}</option>)}
                </select>
              </div>
            ) : null}
            {browser.runtime.isAudible ? <Volume2 className="runtime-audio" aria-label="Reproduciendo audio" size={14} /> : null}
            <details className="card-menu native-occluder" onPointerDown={(event) => event.stopPropagation()} onToggle={(event) => onMenuOpenChange?.(event.currentTarget.open)}>
              <summary aria-label="Acciones del navegador"><Menu size={15} /></summary>
              <div className="card-menu-popover native-occluder" onClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) return;
                event.currentTarget.closest('details')?.removeAttribute('open');
                onMenuOpenChange?.(false);
              }}>
                <button onClick={onFullscreen} type="button">{surface === 'immersive' ? <Shrink size={14} /> : <Expand size={14} />} {surface === 'immersive' ? 'Restaurar' : 'Pantalla completa'}</button>
                <button onClick={onToggleMinimized} type="button"><Shrink size={14} /> Minimizar</button>
                <button onClick={onDuplicate} type="button"><Copy size={14} /> Duplicar</button>
                <button onClick={onToggleLocked} type="button">{browser.positionLocked ? <Unlock size={14} /> : <Lock size={14} />} {browser.positionLocked ? 'Desbloquear' : 'Bloquear posición'}</button>
                <button onClick={onToggleSidebarPin} type="button"><PanelLeft size={14} /> {browser.pin.sidebar ? 'Quitar de fijados' : 'Fijar en sidebar'}</button>
                <button onClick={onToggleViewportPin} type="button"><Pin size={14} /> {browser.pin.viewport ? 'Desanclar del viewport' : 'Fijar al viewport'}</button>
                <button onClick={browser.suspended ? onWake : onSleep} type="button">{browser.suspended ? <RotateCw size={14} /> : <Moon size={14} />} {browser.suspended ? 'Reactivar' : 'Suspender'}</button>
                <label className="card-profile-picker">
                  Perfil
                  <select aria-label={`Perfil de ${browser.title}`} onChange={(event) => onAssignProfile(event.target.value)} value={browser.profileId}>
                    {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select>
                </label>
                {stack && onUnstack ? <button onClick={onUnstack} type="button"><Copy size={14} /> Deshacer stack</button> : null}
                <button className="danger-action" onClick={onClose} type="button"><X size={14} /> Cerrar</button>
              </div>
            </details>
          </>
        ) : (
          <span className="inactive-domain">{displayDomain(browser.url)}</span>
        )}
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
      {resizable ? (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeDirection[]).map((direction) => (
        <span
          aria-hidden="true"
          className={`resize-handle resize-${direction}`}
          key={direction}
          onPointerDown={(event) => onBeginResize(direction, event)}
        />
      )) : null}
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
