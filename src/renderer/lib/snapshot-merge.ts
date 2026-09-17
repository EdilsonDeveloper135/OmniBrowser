import type { BrowserSnapshot, WorkspaceSnapshot } from '../../shared/schemas';

/** Identifies what the pointer is currently manipulating; its local geometry wins over snapshots from the main process. */
export type ActiveInteraction = { kind: 'cards'; browserIds: string[] } | { kind: 'canvas' } | null;

/**
 * Applies a full snapshot from the main process. The main process only knows geometry that the shell already committed,
 * so while a gesture is in progress the dragged card (or the panned camera) keeps its newer local value.
 */
export function mergeWorkspaceSnapshot(current: WorkspaceSnapshot | null, incoming: WorkspaceSnapshot, interaction: ActiveInteraction): WorkspaceSnapshot {
  if (!current || !interaction) return incoming;
  if (interaction.kind === 'canvas') return { ...incoming, camera: current.camera };
  const localById = new Map(current.browsers.filter((browser) => interaction.browserIds.includes(browser.id)).map((browser) => [browser.id, browser]));
  if (localById.size === 0) return incoming;
  return {
    ...incoming,
    browsers: incoming.browsers.map((browser) => {
      const local = localById.get(browser.id);
      return local ? { ...browser, worldRect: local.worldRect } : browser;
    })
  };
}

/** Applies navigation and runtime state for one browser without touching geometry or z-order owned by the canvas. */
export function mergeBrowserState(current: WorkspaceSnapshot | null, incoming: BrowserSnapshot): WorkspaceSnapshot | null {
  if (!current) return current;
  return {
    ...current,
    browsers: current.browsers.map((browser) => browser.id === incoming.id
      ? { ...browser, url: incoming.url, title: incoming.title, suspended: incoming.suspended, runtime: incoming.runtime, updatedAt: incoming.updatedAt }
      : browser)
  };
}
