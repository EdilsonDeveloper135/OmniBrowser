import {
  ArrowLeft,
  ArrowRight,
  Bot,
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
import { memo, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { AgentChatSnapshot, AgentSummary } from '../../shared/schemas';
import { sameRect } from '../../shared/geometry';
import type { BrowserSnapshot, ProfileRecord, StackRecord, WorldRect } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { profileColor } from '../lib/profile-colors';
import { AgentChatPanel, agentStateLabel } from './AgentChatPanel';
import { Favicon } from './Favicon';

export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/**
 * What a card can ask of the canvas. The canvas passes one object with a stable identity whose methods run its latest
 * logic, so a card only re-renders when its own record, geometry or selection state changes.
 */
export interface BrowserCardActions {
  select: (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>) => void;
  beginMove: (browser: BrowserSnapshot, event: ReactPointerEvent<HTMLElement>) => void;
  beginResize: (browser: BrowserSnapshot, direction: ResizeDirection, event: ReactPointerEvent<HTMLElement>) => void;
  close: (browser: BrowserSnapshot) => void;
  sleep: (browser: BrowserSnapshot) => void;
  wake: (browser: BrowserSnapshot) => void;
  reload: (browser: BrowserSnapshot) => void;
  stop: (browser: BrowserSnapshot) => void;
  back: (browser: BrowserSnapshot) => void;
  forward: (browser: BrowserSnapshot) => void;
  navigate: (browser: BrowserSnapshot, url: string) => void;
  assignProfile: (browser: BrowserSnapshot, profileId: string) => void;
  toggleMinimized: (browser: BrowserSnapshot) => void;
  toggleLocked: (browser: BrowserSnapshot) => void;
  toggleSidebarPin: (browser: BrowserSnapshot) => void;
  toggleViewportPin: (browser: BrowserSnapshot) => void;
  duplicate: (browser: BrowserSnapshot) => void;
  fullscreen: (browser: BrowserSnapshot) => void;
  menuOpenChange: (browser: BrowserSnapshot, open: boolean) => void;
  selectStackMember: (stack: StackRecord, browserId: string) => void;
  unstack: (stack: StackRecord) => void;
  toggleAgentPanel: (browser: BrowserSnapshot) => void;
  sendAgentInstruction: (browser: BrowserSnapshot, instruction: string) => void;
  pauseAgent: (browser: BrowserSnapshot) => void;
  resumeAgent: (browser: BrowserSnapshot) => void;
  stopAgent: (browser: BrowserSnapshot) => void;
  openAgentSettings: () => void;
}

interface BrowserCardProps {
  browser: BrowserSnapshot;
  profiles: ProfileRecord[];
  rect: WorldRect;
  surface: 'world' | 'pinned' | 'immersive';
  selected: boolean;
  multiSelected: boolean;
  stack?: StackRecord;
  stackBrowsers: BrowserSnapshot[];
  agentSummary?: AgentSummary | null;
  agentSnapshot?: AgentChatSnapshot | null;
  agentPanelOpen?: boolean;
  agentLoading?: boolean;
  agentError?: string | null;
  agentProviderReady?: boolean;
  actions: BrowserCardActions;
}

function sameBrowsers(a: readonly BrowserSnapshot[], b: readonly BrowserSnapshot[]): boolean {
  return a === b || (a.length === b.length && a.every((browser, index) => browser === b[index]));
}

// Snapshot updates keep the record of every unchanged browser, so identity comparison is exact. Pinned, immersive and
// minimized cards receive a derived rectangle and stack switchers a derived member list, compared by value instead.
export const BrowserCard = memo(BrowserCardView, (previous, next) => previous.browser === next.browser
  && previous.profiles === next.profiles
  && previous.surface === next.surface
  && previous.selected === next.selected
  && previous.multiSelected === next.multiSelected
  && previous.stack === next.stack
  && previous.agentSummary === next.agentSummary
  && previous.agentSnapshot === next.agentSnapshot
  && previous.agentPanelOpen === next.agentPanelOpen
  && previous.agentLoading === next.agentLoading
  && previous.agentError === next.agentError
  && previous.agentProviderReady === next.agentProviderReady
  && previous.actions === next.actions
  && sameRect(previous.rect, next.rect)
  && sameBrowsers(previous.stackBrowsers, next.stackBrowsers));

function BrowserCardView({
  browser,
  profiles,
  rect,
  surface,
  selected,
  multiSelected,
  stack,
  stackBrowsers,
  agentSummary = null,
  agentSnapshot = null,
  agentPanelOpen = false,
  agentLoading = false,
  agentError = null,
  agentProviderReady = false,
  actions
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
    actions.navigate(browser, address);
  };

  if (minimized) {
    return (
      <article
        className={`browser-card minimized-browser-card ${selected ? 'is-selected' : ''} ${multiSelected ? 'is-multi-selected' : ''}`}
        data-browser-id={browser.id}
        onPointerDown={(event) => actions.select(browser, event)}
        style={style}
      >
        <header className="browser-card-header minimized-header" onPointerDown={(event) => actions.beginMove(browser, event)}>
          <Favicon browser={browser} />
          <span className="inactive-domain">{displayDomain(browser.url)}</span>
          {browser.positionLocked ? <Lock aria-label="Posición bloqueada" size={12} /> : null}
          <button
            aria-label={`Abrir agente (${agentStateLabel(agentSummary?.state ?? 'idle')})`}
            className={`card-agent-button is-${agentSummary?.state ?? 'idle'}`}
            onClick={(event) => { event.stopPropagation(); actions.toggleAgentPanel(browser); }}
            type="button"
          >
            <Bot size={14} />
            <span aria-hidden="true" className="card-agent-state-dot" />
          </button>
          <button aria-label="Restaurar navegador" onClick={(event) => { event.stopPropagation(); actions.toggleMinimized(browser); }} type="button"><Shrink size={14} /></button>
        </header>
      </article>
    );
  }

  return (
    <article
      className={`browser-card surface-${surface} ${selected ? 'is-selected is-active' : ''} ${multiSelected ? 'is-multi-selected' : ''}`}
      data-browser-id={browser.id}
      onPointerDown={(event) => actions.select(browser, event)}
      style={style}
    >
      <header className="browser-card-header" onPointerDown={surface === 'immersive' ? undefined : (event) => actions.beginMove(browser, event)}>
        {selected ? (
          <>
            {movable ? <GripVertical className="drag-grip" size={15} aria-hidden="true" /> : browser.positionLocked ? <Lock className="drag-grip" size={13} /> : <Pin className="drag-grip" size={13} />}
            <div className="card-navigation" onPointerDown={(event) => event.stopPropagation()}>
              <button aria-label="Atrás" disabled={!browser.runtime.canGoBack} onClick={() => actions.back(browser)} type="button"><ArrowLeft size={14} /></button>
              <button aria-label="Adelante" disabled={!browser.runtime.canGoForward} onClick={() => actions.forward(browser)} type="button"><ArrowRight size={14} /></button>
              <button aria-label={browser.runtime.isLoading ? 'Detener' : 'Recargar'} onClick={() => (browser.runtime.isLoading ? actions.stop : actions.reload)(browser)} type="button">
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
                <select aria-label="Miembro visible del stack" onChange={(event) => actions.selectStackMember(stack, event.target.value)} value={browser.id}>
                  {stackBrowsers.map((member) => <option key={member.id} value={member.id}>{member.title || displayDomain(member.url)}</option>)}
                </select>
              </div>
            ) : null}
            {browser.runtime.isAudible ? <Volume2 className="runtime-audio" aria-label="Reproduciendo audio" size={14} /> : null}
            <button
              aria-expanded={agentPanelOpen}
              aria-label={`${agentPanelOpen ? 'Cerrar' : 'Abrir'} agente (${agentStateLabel(agentSummary?.state ?? 'idle')})`}
              className={`card-agent-button is-${agentSummary?.state ?? 'idle'} ${agentPanelOpen ? 'is-open' : ''}`}
              onClick={() => actions.toggleAgentPanel(browser)}
              onPointerDown={(event) => event.stopPropagation()}
              title={`${agentStateLabel(agentSummary?.state ?? 'idle')}${agentSummary?.queuedTaskCount ? ` · ${agentSummary.queuedTaskCount} en cola` : ''}`}
              type="button"
            >
              <Bot size={14} />
              <span aria-hidden="true" className="card-agent-state-dot" />
            </button>
            <details className="card-menu native-occluder" onPointerDown={(event) => event.stopPropagation()} onToggle={(event) => actions.menuOpenChange(browser, event.currentTarget.open)}>
              <summary aria-label="Acciones del navegador"><Menu size={15} /></summary>
              <div className="card-menu-popover native-occluder" onClick={(event) => {
                if (!(event.target as HTMLElement).closest('button')) return;
                event.currentTarget.closest('details')?.removeAttribute('open');
                actions.menuOpenChange(browser, false);
              }}>
                <button onClick={() => actions.fullscreen(browser)} type="button">{surface === 'immersive' ? <Shrink size={14} /> : <Expand size={14} />} {surface === 'immersive' ? 'Restaurar' : 'Pantalla completa'}</button>
                <button onClick={() => actions.toggleMinimized(browser)} type="button"><Shrink size={14} /> Minimizar</button>
                <button onClick={() => actions.duplicate(browser)} type="button"><Copy size={14} /> Duplicar</button>
                <button onClick={() => actions.toggleLocked(browser)} type="button">{browser.positionLocked ? <Unlock size={14} /> : <Lock size={14} />} {browser.positionLocked ? 'Desbloquear' : 'Bloquear posición'}</button>
                <button onClick={() => actions.toggleSidebarPin(browser)} type="button"><PanelLeft size={14} /> {browser.pin.sidebar ? 'Quitar de fijados' : 'Fijar en sidebar'}</button>
                <button onClick={() => actions.toggleViewportPin(browser)} type="button"><Pin size={14} /> {browser.pin.viewport ? 'Desanclar del viewport' : 'Fijar al viewport'}</button>
                <button onClick={() => (browser.suspended ? actions.wake : actions.sleep)(browser)} type="button">{browser.suspended ? <RotateCw size={14} /> : <Moon size={14} />} {browser.suspended ? 'Reactivar' : 'Suspender'}</button>
                <label className="card-profile-picker">
                  Perfil
                  <select aria-label={`Perfil de ${browser.title}`} onChange={(event) => actions.assignProfile(browser, event.target.value)} value={browser.profileId}>
                    {profiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                  </select>
                </label>
                {stack ? <button onClick={() => actions.unstack(stack)} type="button"><Copy size={14} /> Deshacer stack</button> : null}
                <button className="danger-action" onClick={() => actions.close(browser)} type="button"><X size={14} /> Cerrar</button>
              </div>
            </details>
          </>
        ) : (
          <>
            <span className="inactive-domain">{displayDomain(browser.url)}</span>
            <button
              aria-expanded={agentPanelOpen}
              aria-label={`${agentPanelOpen ? 'Cerrar' : 'Abrir'} agente (${agentStateLabel(agentSummary?.state ?? 'idle')})`}
              className={`card-agent-button is-${agentSummary?.state ?? 'idle'} ${agentPanelOpen ? 'is-open' : ''}`}
              onClick={() => actions.toggleAgentPanel(browser)}
              onPointerDown={(event) => event.stopPropagation()}
              type="button"
            >
              <Bot size={14} />
              <span aria-hidden="true" className="card-agent-state-dot" />
            </button>
          </>
        )}
      </header>
      <div className={`browser-card-body ${agentPanelOpen ? 'has-agent-panel' : ''}`}>
        <div className="browser-content-slot" data-browser-content={browser.id} data-browser-native-pane={browser.id}>
          <div className="browser-placeholder">
            {browser.suspended ? <Moon size={30} /> : browser.runtime.crashed ? <CircleAlert size={30} /> : <span className="placeholder-globe" />}
            <strong>{browser.suspended ? 'Navegador en reposo' : browser.runtime.crashed ? 'La vista dejó de responder' : browser.title || 'Nueva página'}</strong>
            <span>{displayDomain(browser.url)}</span>
            {browser.suspended ? <button onClick={() => actions.wake(browser)} type="button">Activar navegador</button> : null}
            {!browser.suspended && browser.runtime.crashed ? <button onClick={() => actions.reload(browser)} type="button">Recargar</button> : null}
          </div>
        </div>
        {agentPanelOpen ? (
          <AgentChatPanel
            browserId={browser.id}
            error={agentError}
            loading={agentLoading}
            onClose={() => actions.toggleAgentPanel(browser)}
            onOpenSettings={actions.openAgentSettings}
            onPause={() => actions.pauseAgent(browser)}
            onResume={() => actions.resumeAgent(browser)}
            onSend={(instruction) => actions.sendAgentInstruction(browser, instruction)}
            onStop={() => actions.stopAgent(browser)}
            providerReady={agentProviderReady}
            snapshot={agentSnapshot}
            summary={agentSummary}
          />
        ) : null}
      </div>
      {resizable ? (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as ResizeDirection[]).map((direction) => (
        <span
          aria-hidden="true"
          className={`resize-handle resize-${direction}`}
          key={direction}
          onPointerDown={(event) => actions.beginResize(browser, direction, event)}
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
