import { Check, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { ProfileRecord } from '../../shared/schemas';
import { profileColor } from '../lib/profile-colors';

interface ProfileRailProps {
  profiles: ProfileRecord[];
  activeProfileId: string | null;
  onSelect: (profileId: string) => void;
  onCreate: (name: string, kind: ProfileRecord['kind']) => Promise<boolean>;
}

export function ProfileRail({ profiles, activeProfileId, onSelect, onCreate }: ProfileRailProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProfileRecord['kind']>('persistent');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      // On failure (for example a duplicate name) the panel stays open with the typed name so it can be corrected.
      if (!await onCreate(name.trim(), kind)) return;
      setName('');
      setKind('persistent');
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="profile-rail" aria-label="Perfiles">
      <div className="traffic-light-space" aria-hidden="true" />
      <div className="brand-row">
        <span className="brand-mark" aria-hidden="true"><span /><span /></span>
        <span>OmniBrowser</span>
      </div>
      <nav className="profile-list">
        {profiles.map((profile, index) => (
          <button
            className={`profile-row ${activeProfileId === profile.id ? 'is-active' : ''}`}
            key={profile.id}
            onClick={() => onSelect(profile.id)}
            type="button"
          >
            <span className="profile-dot" style={{ background: profileColor(profile, index) }} />
            <span className="profile-name">{profile.name}</span>
            {profile.kind === 'temporary' ? <span className="profile-kind">temporal</span> : null}
          </button>
        ))}
      </nav>

      {creating ? (
        <div className="profile-create-panel">
          <div className="profile-create-title">Nuevo perfil</div>
          <input
            autoFocus
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
              if (event.key === 'Escape') setCreating(false);
            }}
            placeholder="Nombre"
            value={name}
          />
          <div className="profile-kind-choice" role="group" aria-label="Persistencia del perfil">
            <button className={kind === 'persistent' ? 'is-selected' : ''} onClick={() => setKind('persistent')} type="button">Persistente</button>
            <button className={kind === 'temporary' ? 'is-selected' : ''} onClick={() => setKind('temporary')} type="button">Temporal</button>
          </div>
          <div className="profile-create-actions">
            <button className="icon-button quiet" aria-label="Cancelar" onClick={() => setCreating(false)} type="button"><X size={15} /></button>
            <button className="icon-button primary" aria-label="Crear perfil" disabled={!name.trim() || busy} onClick={() => void submit()} type="button"><Check size={15} /></button>
          </div>
        </div>
      ) : null}

      <button className="add-profile-button" onClick={() => setCreating(true)} type="button">
        <Plus size={17} />
        <span>Perfil</span>
      </button>
    </aside>
  );
}
