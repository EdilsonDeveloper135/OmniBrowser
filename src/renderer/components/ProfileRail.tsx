import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  Layers3,
  LoaderCircle,
  Lock,
  Pin,
  Plus,
  Search,
  Shrink,
  Volume2,
  X
} from 'lucide-react';
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserSnapshot, ProfileRecord, WorkspaceSnapshot, ZoneRecord } from '../../shared/schemas';
import { displayDomain } from '../../shared/urls';
import { profileColor } from '../lib/profile-colors';
import { browserMatchesSidebarSearch, buildSidebarTreeIndex, normalizeSidebarSearch } from '../lib/sidebar-tree';
import { useEventCallback } from '../lib/use-event-callback';
import { Favicon } from './Favicon';

export type SidebarDropDestination =
  | { kind: 'pinned' }
  | { kind: 'root' }
  | { kind: 'profile'; id: string }
  | { kind: 'zone'; id: string }
  | { kind: 'stack'; id: string }
  | { kind: 'browser'; id: string };

interface ProfileRailProps {
  snapshot: WorkspaceSnapshot;
  activeProfileId: string | null;
  selectedBrowserIds: ReadonlySet<string>;
  onSelectProfile: (profileId: string) => void;
  onCreate: (name: string, kind: ProfileRecord['kind']) => Promise<boolean>;
  onLocate: (browserId: string) => void;
  onClose: (browserId: string) => void;
  onToggleZone: (zone: ZoneRecord) => void;
  onToggleSidebarPin: (browser: BrowserSnapshot) => void;
  onSelectStackMember: (stackId: string, browserId: string) => void;
  onDropBrowser: (browserId: string, destination: SidebarDropDestination) => void;
}

interface SidebarBrowserRowProps {
  browser: BrowserSnapshot;
  stackId?: string;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onActivate: (browserId: string) => void;
  onBeginDrag: (browserId: string, event: ReactPointerEvent<HTMLElement>) => void;
  onToggleSidebarPin: (browser: BrowserSnapshot) => void;
  onClose: (browserId: string) => void;
  onSelectStackMember: (stackId: string, browserId: string) => void;
}

// Rows re-render only when their own browser record or row state changes: moving a card or a runtime update of one page
// must not rebuild the other rows of a 500-browser tree.
const SidebarBrowserRow = memo(function SidebarBrowserRow({ browser, stackId, selected, dragging, dropTarget, onActivate, onBeginDrag, onToggleSidebarPin, onClose, onSelectStackMember }: SidebarBrowserRowProps) {
  return (
    <div
      className={`sidebar-browser-row ${selected ? 'is-selected' : ''} ${dragging ? 'is-dragging' : ''} ${dropTarget ? 'is-drop-target' : ''}`}
      data-drop-id={browser.id}
      data-drop-kind="browser"
      onClick={() => onActivate(browser.id)}
      onPointerDown={(event) => onBeginDrag(browser.id, event)}
      role="button"
      tabIndex={0}
    >
      <Favicon browser={browser} variant="sidebar" />
      <span className="sidebar-browser-copy">
        <strong>{browser.title || displayDomain(browser.url)}</strong>
        <small>{displayDomain(browser.url)}</small>
      </span>
      <span className="sidebar-browser-states">
        {browser.runtime.isAudible ? <Volume2 aria-label="Audio" size={11} /> : null}
        {browser.runtime.isLoading ? <LoaderCircle aria-label="Cargando" className="spin" size={11} /> : null}
        {browser.runtime.download.activeCount > 0 ? <Download aria-label="Descargando" size={11} /> : null}
        {browser.runtime.lastError ? <CircleAlert aria-label="Error" size={11} /> : null}
        {browser.presentation === 'minimized' ? <Shrink aria-label="Minimizado" size={11} /> : null}
        {browser.positionLocked ? <Lock aria-label="Bloqueado" size={11} /> : null}
        {browser.pin.viewport ? <Pin aria-label="Fijado al viewport" size={11} /> : null}
      </span>
      <button className={`sidebar-pin-button ${browser.pin.sidebar ? 'is-active' : ''}`} aria-label={browser.pin.sidebar ? 'Quitar de fijados' : 'Fijar'} onClick={(event) => { event.stopPropagation(); onToggleSidebarPin(browser); }} type="button"><Pin size={11} /></button>
      <button className="sidebar-close-button" aria-label={`Cerrar ${browser.title}`} onClick={(event) => { event.stopPropagation(); onClose(browser.id); }} type="button"><X size={12} /></button>
      {stackId ? <button className="sidebar-stack-activate" aria-label="Mostrar en el stack" onClick={(event) => { event.stopPropagation(); onSelectStackMember(stackId, browser.id); }} type="button">Mostrar</button> : null}
    </div>
  );
});

function toggleSet(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
}

export function ProfileRail({
  snapshot,
  activeProfileId,
  selectedBrowserIds,
  onSelectProfile,
  onCreate,
  onLocate,
  onClose,
  onToggleZone,
  onToggleSidebarPin,
  onSelectStackMember,
  onDropBrowser
}: ProfileRailProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProfileRecord['kind']>('persistent');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsedProfiles, setCollapsedProfiles] = useState<Set<string>>(() => new Set());
  const [collapsedZones, setCollapsedZones] = useState<Set<string>>(() => new Set());
  const [collapsedStacks, setCollapsedStacks] = useState<Set<string>>(() => new Set());
  const [draggingBrowserId, setDraggingBrowserId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const lastDragAt = useRef(0);
  const query = normalizeSidebarSearch(search);

  const { browsers, browserOrder, zones, stacks } = snapshot;
  const tree = useMemo(() => buildSidebarTreeIndex({ browsers, browserOrder, zones, stacks }), [browsers, browserOrder, zones, stacks]);
  const visibleIds = useMemo(() => new Set(tree.orderedBrowsers.filter((browser) => browserMatchesSidebarSearch(browser, query)).map((browser) => browser.id)), [tree.orderedBrowsers, query]);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (!await onCreate(name.trim(), kind)) return;
      setName('');
      setKind('persistent');
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  const targetFromPoint = (x: number, y: number): SidebarDropDestination | null => {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-kind]');
    if (!element?.dataset.dropKind) return null;
    const kind = element.dataset.dropKind as SidebarDropDestination['kind'];
    if (kind === 'pinned' || kind === 'root') return { kind };
    return element.dataset.dropId ? { kind, id: element.dataset.dropId } as SidebarDropDestination : null;
  };

  const beginPointerDrag = useEventCallback((browserId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    const start = { x: event.clientX, y: event.clientY };
    let active = false;
    let destination: SidebarDropDestination | null = null;
    const move = (pointer: PointerEvent) => {
      if (!active && Math.hypot(pointer.clientX - start.x, pointer.clientY - start.y) < 5) return;
      if (!active) {
        active = true;
        setDraggingBrowserId(browserId);
      }
      destination = targetFromPoint(pointer.clientX, pointer.clientY);
      setDropTarget(destination ? `${destination.kind}:${'id' in destination ? destination.id : ''}` : null);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (active && destination) {
        lastDragAt.current = Date.now();
        onDropBrowser(browserId, destination);
      }
      setDraggingBrowserId(null);
      setDropTarget(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  });
  const activateRow = useEventCallback((browserId: string) => {
    if (Date.now() - lastDragAt.current > 250) onLocate(browserId);
  });
  const toggleRowPin = useEventCallback((browser: BrowserSnapshot) => onToggleSidebarPin(browser));
  const closeRow = useEventCallback((browserId: string) => onClose(browserId));
  const selectRowStackMember = useEventCallback((stackId: string, browserId: string) => onSelectStackMember(stackId, browserId));

  const browserRow = (browser: BrowserSnapshot, options: { stackId?: string; reference?: boolean } = {}) => {
    if (!visibleIds.has(browser.id)) return null;
    return (
      <SidebarBrowserRow
        browser={browser}
        dragging={draggingBrowserId === browser.id}
        dropTarget={dropTarget === `browser:${browser.id}`}
        key={`${options.reference ? 'pin-' : ''}${browser.id}`}
        onActivate={activateRow}
        onBeginDrag={beginPointerDrag}
        onClose={closeRow}
        onSelectStackMember={selectRowStackMember}
        onToggleSidebarPin={toggleRowPin}
        selected={selectedBrowserIds.has(browser.id)}
        stackId={options.stackId}
      />
    );
  };

  const pinned = tree.orderedBrowsers.filter((browser) => browser.pin.sidebar && visibleIds.has(browser.id));

  return (
    <aside className="profile-rail" aria-label="Perfiles y navegadores" data-drop-kind="root">
      <div className="traffic-light-space" aria-hidden="true" />
      <div className="brand-row">
        <span className="brand-mark" aria-hidden="true"><span /><span /></span>
        <span>OmniBrowser</span>
      </div>
      <label className="sidebar-search">
        <Search size={13} />
        <input aria-label="Buscar navegadores abiertos" onChange={(event) => setSearch(event.target.value)} placeholder="Buscar título, dominio o URL" value={search} />
        {search ? <button aria-label="Limpiar búsqueda" onClick={() => setSearch('')} type="button"><X size={12} /></button> : null}
      </label>

      <nav className="profile-tree">
        <section className={`tree-section pinned-section ${dropTarget === 'pinned:' ? 'is-drop-target' : ''}`} data-drop-kind="pinned">
          <div className="tree-heading"><Pin size={12} /><strong>Fijados</strong><span>{pinned.length}</span></div>
          {pinned.length ? pinned.map((browser) => browserRow(browser, { reference: true })) : <div className="tree-empty">Arrastra aquí para fijar</div>}
        </section>

        {snapshot.profiles.map((profile, profileIndex) => {
          const profileBrowsers = tree.browsersByProfile.get(profile.id) ?? [];
          const matchingCount = profileBrowsers.filter((browser) => visibleIds.has(browser.id)).length;
          if (query && matchingCount === 0) return null;
          const collapsed = !query && collapsedProfiles.has(profile.id);
          const profileTarget = `profile:${profile.id}`;
          const zones = tree.zonesByProfile.get(profile.id) ?? [];
          const loose = tree.looseBrowsersByProfile.get(profile.id) ?? [];
          return (
            <section className={`tree-section profile-tree-section ${dropTarget === profileTarget ? 'is-drop-target' : ''}`} data-drop-id={profile.id} data-drop-kind="profile" key={profile.id}>
              <button className={`profile-row ${activeProfileId === profile.id ? 'is-active' : ''}`} onClick={() => onSelectProfile(profile.id)} type="button">
                <span onClick={(event) => { event.stopPropagation(); toggleSet(setCollapsedProfiles, profile.id); }}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</span>
                <span className="profile-dot" style={{ background: profileColor(profile, profileIndex) }} />
                <span className="profile-name">{profile.name}</span>
                <span className="tree-count">{profileBrowsers.length}</span>
                {profile.kind === 'private' ? <span className="profile-kind">private</span> : null}
              </button>
              {!collapsed ? (
                <div className="tree-children">
                  {loose.map((browser) => browserRow(browser))}
                  {zones.map((zone) => {
                    const zoneBrowsers = tree.browsersByZone.get(zone.id) ?? [];
                    if (query && !zoneBrowsers.some((browser) => visibleIds.has(browser.id))) return null;
                    const zoneCollapsed = !query && collapsedZones.has(zone.id);
                    const zoneTarget = `zone:${zone.id}`;
                    const zoneStacks = tree.stacksByZone.get(zone.id) ?? [];
                    const stackedIds = tree.stackedBrowserIdsByZone.get(zone.id) ?? new Set<string>();
                    return (
                      <div className={`zone-tree-node ${dropTarget === zoneTarget ? 'is-drop-target' : ''}`} data-drop-id={zone.id} data-drop-kind="zone" key={zone.id}>
                        <div className="zone-tree-heading">
                          <button aria-label={zoneCollapsed ? 'Expandir zona' : 'Contraer zona'} onClick={() => toggleSet(setCollapsedZones, zone.id)} type="button">{zoneCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
                          <span className="zone-color" style={{ background: zone.color }} />
                          <button className="zone-name-button" onClick={() => onToggleZone(zone)} type="button">{zone.name}</button>
                          <span>{zoneBrowsers.length}</span>
                        </div>
                        {!zoneCollapsed ? (
                          <div className="tree-children zone-children">
                            {zoneStacks.map((stack) => {
                              const members = tree.stackMembersById.get(stack.id) ?? [];
                              if (query && !members.some((browser) => visibleIds.has(browser.id))) return null;
                              const stackCollapsed = !query && collapsedStacks.has(stack.id);
                              const stackTarget = `stack:${stack.id}`;
                              return (
                                <div className={`stack-tree-node ${dropTarget === stackTarget ? 'is-drop-target' : ''}`} data-drop-id={stack.id} data-drop-kind="stack" key={stack.id}>
                                  <button className="stack-tree-heading" onClick={() => toggleSet(setCollapsedStacks, stack.id)} type="button">
                                    {stackCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<Layers3 size={12} /><span>Stack</span><small>{members.length}</small>
                                  </button>
                                  {!stackCollapsed ? members.map((browser) => browserRow(browser, { stackId: stack.id })) : null}
                                </div>
                              );
                            })}
                            {zoneBrowsers.filter((browser) => !stackedIds.has(browser.id)).map((browser) => browserRow(browser))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {profileBrowsers.length === 0 ? <div className="tree-empty">Sin navegadores</div> : null}
                </div>
              ) : null}
            </section>
          );
        })}
      </nav>

      {creating ? (
        <div className="profile-create-panel">
          <div className="profile-create-title">Nuevo perfil</div>
          <input autoFocus maxLength={48} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); if (event.key === 'Escape') setCreating(false); }} placeholder="Nombre" value={name} />
          <div className="profile-kind-choice" role="group" aria-label="Persistencia del perfil">
            <button className={kind === 'persistent' ? 'is-selected' : ''} onClick={() => setKind('persistent')} type="button">Persistente</button>
            <button className={kind === 'private' ? 'is-selected' : ''} onClick={() => setKind('private')} type="button">Private</button>
          </div>
          {kind === 'private' ? <p className="private-copy">Private by design. No accounts, no sync servers, no browsing log. Your canvas lives on your machine.</p> : null}
          <div className="profile-create-actions">
            <button className="icon-button quiet" aria-label="Cancelar" onClick={() => setCreating(false)} type="button"><X size={15} /></button>
            <button className="icon-button primary" aria-label="Crear perfil" disabled={!name.trim() || busy} onClick={() => void submit()} type="button"><Check size={15} /></button>
          </div>
        </div>
      ) : null}

      <button className="add-profile-button" onClick={() => setCreating(true)} type="button"><Plus size={17} /><span>Perfil</span></button>
    </aside>
  );
}
