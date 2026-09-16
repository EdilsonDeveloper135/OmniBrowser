export interface Stackable {
  id: string;
  zIndex: number;
  createdAt: string;
}

/**
 * Moves one item to the top and renumbers the stack densely (1..n). The main process applies the same rule, so the
 * shell's optimistic focus and the persisted z-order always agree.
 */
export function raiseToTop<T extends Stackable>(items: readonly T[], id: string): T[] {
  const ordered = [...items].sort((a, b) => a.zIndex - b.zIndex || a.createdAt.localeCompare(b.createdAt));
  const target = ordered.find((item) => item.id === id);
  if (!target) return [...items];
  const stack = [...ordered.filter((item) => item.id !== id), target];
  const zIndexById = new Map(stack.map((item, index) => [item.id, index + 1]));
  return items.map((item) => ({ ...item, zIndex: zIndexById.get(item.id) ?? item.zIndex }));
}
