import { describe, expect, it } from 'vitest';
import { ShellNotices, type ShellNotice } from '../../src/main/ipc/shell-notices';

function harness(options: { maxPending?: number } = {}) {
  let now = 0;
  const delivered: ShellNotice[] = [];
  const notices = new ShellNotices((notice) => delivered.push(notice), { now: () => now, deduplicationMs: 4000, ...options });
  return { notices, delivered, advance: (ms: number) => { now += ms; } };
}

describe('ShellNotices', () => {
  it('holds notices raised before the shell subscribes and hands them over in order when it bootstraps', () => {
    const { notices, delivered } = harness();
    notices.push('warning', 'Se recuperó workspace.backup.json.');
    notices.push('warning', 'No se pudo cargar 127.0.0.1 (ERR_CONNECTION_REFUSED).');
    expect(delivered).toEqual([]);
    expect(notices.takePendingOnSubscribe()).toEqual([
      { level: 'warning', message: 'Se recuperó workspace.backup.json.' },
      { level: 'warning', message: 'No se pudo cargar 127.0.0.1 (ERR_CONNECTION_REFUSED).' }
    ]);
    expect(notices.takePendingOnSubscribe()).toEqual([]);
    notices.push('error', 'Una vista del navegador dejó de responder.');
    expect(delivered).toEqual([{ level: 'error', message: 'Una vista del navegador dejó de responder.' }]);
  });

  it('holds notices again while a reloaded shell document has not bootstrapped', () => {
    const { notices, delivered } = harness();
    notices.takePendingOnSubscribe();
    notices.unsubscribe();
    notices.push('info', 'uno');
    expect(delivered).toEqual([]);
    expect(notices.takePendingOnSubscribe()).toEqual([{ level: 'info', message: 'uno' }]);
  });

  it('shows identical notices once per window, before and after the shell subscribes', () => {
    const { notices, delivered, advance } = harness();
    notices.push('warning', 'Permiso bloqueado por la política del MVP: geolocation.');
    notices.push('warning', 'Permiso bloqueado por la política del MVP: geolocation.');
    expect(notices.takePendingOnSubscribe()).toHaveLength(1);
    notices.push('warning', 'Permiso bloqueado por la política del MVP: geolocation.');
    expect(delivered).toHaveLength(0);
    advance(4000);
    notices.push('warning', 'Permiso bloqueado por la política del MVP: geolocation.');
    notices.push('error', 'Permiso bloqueado por la política del MVP: geolocation.');
    expect(delivered).toEqual([
      { level: 'warning', message: 'Permiso bloqueado por la política del MVP: geolocation.' },
      { level: 'error', message: 'Permiso bloqueado por la política del MVP: geolocation.' }
    ]);
  });

  it('keeps only the most recent notices while nobody is listening', () => {
    const { notices } = harness({ maxPending: 3 });
    for (let index = 1; index <= 5; index += 1) notices.push('info', `aviso ${index}`);
    expect(notices.takePendingOnSubscribe().map((notice) => notice.message)).toEqual(['aviso 3', 'aviso 4', 'aviso 5']);
  });
});
