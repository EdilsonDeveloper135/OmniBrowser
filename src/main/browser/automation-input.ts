import type { WebContents } from 'electron';

// Input that an agent synthesizes through CDP reaches the page like the user's and Electron reports it through
// 'input-event' while the Input.* command is still in flight. The agent gateway brackets those commands so that the
// runtime can tell an agent's click from the user's and never selects or raises a card on the agent's behalf.
const syntheticInputDepth = new WeakMap<WebContents, number>();

export async function withSyntheticInput<T>(contents: WebContents, dispatch: () => Promise<T>): Promise<T> {
  syntheticInputDepth.set(contents, (syntheticInputDepth.get(contents) ?? 0) + 1);
  try {
    return await dispatch();
  } finally {
    const depth = (syntheticInputDepth.get(contents) ?? 1) - 1;
    if (depth > 0) syntheticInputDepth.set(contents, depth);
    else syntheticInputDepth.delete(contents);
  }
}

export function isSyntheticInputInFlight(contents: WebContents): boolean {
  return (syntheticInputDepth.get(contents) ?? 0) > 0;
}
