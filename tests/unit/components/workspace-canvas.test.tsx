// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCanvas, type WorkspaceCanvasProps } from '../../../src/renderer/components/WorkspaceCanvas';
import type { BrowserSnapshot, ProfileRecord, WorkspaceSnapshot } from '../../../src/shared/schemas';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  commitLayoutMock.mockClear();
});

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

const commitLayoutMock = vi.fn(async () => {});

(window as unknown as { omniBrowser: unknown }).omniBrowser = {
  workspace: {
    commitLayout: commitLayoutMock,
    setCamera: vi.fn(async () => {})
  }
};

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({ x, y, width, height })
  } as DOMRect;
}

const mockProfile: ProfileRecord = {
  id: 'profile-1',
  name: 'Default Profile',
  color: '#2f81f7',
  kind: 'persistent',
  createdAt: '2026-01-01T00:00:00.000Z'
};

function createMockBrowser(id: string, overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    id,
    profileId: 'profile-1',
    url: 'https://example.com',
    title: `Browser ${id}`,
    worldRect: { x: 100, y: 100, width: 800, height: 600 },
    zIndex: 1,
    suspended: false,
    positionLocked: false,
    presentation: 'normal',
    pin: { sidebar: false, viewport: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    zoneId: null,
    runtime: {
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      isAudioPlaying: false,
      crashed: false,
      faviconKey: null,
      download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' },
      lastError: null
    },
    ...overrides
  };
}

function createMockSnapshot(browsers: BrowserSnapshot[] = []): WorkspaceSnapshot {
  return {
    schemaVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    camera: { panX: 0, panY: 0, zoom: 1 },
    selectedBrowserId: browsers[0]?.id ?? null,
    saveStatus: 'saved',
    profiles: [mockProfile],
    browsers,
    browserOrder: browsers.map((b) => b.id),
    zones: [],
    stacks: [],
    preferences: { snapEnabled: false, historySwipeEnabled: false }
  };
}

function createDefaultProps(overrides: Partial<WorkspaceCanvasProps> = {}): WorkspaceCanvasProps {
  const browser1 = createMockBrowser('b1', { worldRect: { x: 50, y: 50, width: 600, height: 400 } });
  const browser2 = createMockBrowser('b2', { worldRect: { x: 700, y: 50, width: 600, height: 400 } });
  const snapshot = createMockSnapshot([browser1, browser2]);

  return {
    snapshot,
    noticeId: null,
    modalActive: false,
    openAgentPanelIds: new Set(),
    agentSummaries: new Map(),
    agentSnapshots: new Map(),
    agentLoadingIds: new Set(),
    agentErrors: new Map(),
    selectedBrowserIds: new Set(['b1']),
    fullscreenBrowserId: null,
    locateRequest: null,
    onSelectionChange: vi.fn(),
    onFullscreenChange: vi.fn(),
    onUpdateBrowserRects: vi.fn(),
    onUpdateCamera: vi.fn(),
    onFocus: vi.fn(),
    onClearFocus: vi.fn(async () => {}),
    onClose: vi.fn(async () => {}),
    onSleep: vi.fn(async () => {}),
    onWake: vi.fn(async () => {}),
    onReload: vi.fn(async () => {}),
    onStop: vi.fn(async () => {}),
    onBack: vi.fn(async () => {}),
    onForward: vi.fn(async () => {}),
    onNavigate: vi.fn(async () => {}),
    onAssignProfile: vi.fn(async () => {}),
    onSetPresentation: vi.fn(async () => {}),
    onSetLocked: vi.fn(async () => {}),
    onSetSidebarPinned: vi.fn(async () => {}),
    onSetViewportPin: vi.fn(async () => {}),
    onDuplicate: vi.fn(async () => {}),
    onCreateZone: vi.fn(async () => {}),
    onSetZoneCollapsed: vi.fn(async () => {}),
    onCreateStack: vi.fn(async () => {}),
    onSelectStackMember: vi.fn(async () => {}),
    onUnstack: vi.fn(async () => {}),
    onAgentPanelOpenChange: vi.fn(),
    onAgentSend: vi.fn(async () => {}),
    onAgentPause: vi.fn(async () => {}),
    onAgentResume: vi.fn(async () => {}),
    onAgentStop: vi.fn(async () => {}),
    onOpenAgentSettings: vi.fn(),
    onInteractionChange: vi.fn(),
    onViewportChange: vi.fn(),
    ...overrides
  };
}

describe('WorkspaceCanvas component', () => {
  it('renders canvas element and navigator controls', () => {
    const props = createDefaultProps();
    const { container } = render(<WorkspaceCanvas {...props} />);

    const viewport = container.querySelector('.canvas-viewport');
    expect(viewport).not.toBeNull();

    const navigator = screen.getByLabelText('Navegación del canvas');
    expect(navigator).not.toBeNull();
  });

  it('renders browser cards on the canvas surface', () => {
    const props = createDefaultProps();
    const { container } = render(<WorkspaceCanvas {...props} />);

    const cards = container.querySelectorAll('article.browser-card');
    expect(cards.length).toBe(2);
  });

  it('renders selection toolbar when multiple browsers are selected', () => {
    const props = createDefaultProps({
      selectedBrowserIds: new Set(['b1', 'b2'])
    });
    const { container } = render(<WorkspaceCanvas {...props} />);

    const toolbar = container.querySelector('.selection-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.textContent).toContain('2 seleccionados');

    const zoneButton = screen.getByRole('button', { name: 'Zona' });
    expect(zoneButton).not.toBeNull();
    fireEvent.click(zoneButton);
    expect(props.onCreateZone).toHaveBeenCalledWith(['b1', 'b2']);
  });

  it('recomputes when modalActive prop changes', () => {
    const props = createDefaultProps({ modalActive: false });
    const { rerender } = render(<WorkspaceCanvas {...props} />);

    const mockBackdrop = document.createElement('div');
    mockBackdrop.className = 'modal-backdrop native-occluder';
    document.body.appendChild(mockBackdrop);

    rerender(<WorkspaceCanvas {...props} modalActive={true} />);

    document.body.removeChild(mockBackdrop);
  });

  it('expands a narrow card to the agent split minimum without moving it', () => {
    const props = createDefaultProps();
    const { container } = render(<WorkspaceCanvas {...props} />);
    const firstCard = container.querySelector<HTMLElement>('[data-browser-id="b1"]');
    const agentButton = firstCard?.querySelector<HTMLButtonElement>('button[aria-label^="Abrir agente"]');
    expect(agentButton).not.toBeNull();

    fireEvent.click(agentButton!);

    expect(props.onAgentPanelOpenChange).toHaveBeenCalledWith('b1', true);
    expect(props.onUpdateBrowserRects).toHaveBeenCalledTimes(1);
    const updates = vi.mocked(props.onUpdateBrowserRects).mock.calls[0]?.[0];
    expect(updates?.get('b1')).toEqual({ x: 50, y: 50, width: 680, height: 400 });
  });

  it('also widens a viewport-pinned card enough for the browser/chat split', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      const element = this as HTMLElement;
      if (element.classList.contains('canvas-viewport')) return domRect(0, 0, 1200, 800);
      return domRect(0, 0, 0, 0);
    });
    const browser = createMockBrowser('b1', {
      worldRect: { x: 50, y: 50, width: 600, height: 400 },
      pin: { sidebar: false, viewport: { x: 0.1, y: 0.1, width: 0.25, height: 0.6 } }
    });
    const props = createDefaultProps({ snapshot: createMockSnapshot([browser]) });
    const { container } = render(<WorkspaceCanvas {...props} />);
    await waitFor(() => expect(props.onViewportChange).toHaveBeenCalledWith({ width: 1200, height: 800 }));

    const agentButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Abrir agente"]');
    fireEvent.click(agentButton!);

    expect(props.onSetViewportPin).toHaveBeenCalledWith('b1', {
      x: 0.1,
      y: 0.1,
      width: 680 / 1200,
      height: 0.6
    });
  });

  it('keeps agent panels independently open for multiple browser cards', () => {
    const props = createDefaultProps({ openAgentPanelIds: new Set(['b1', 'b2']) });
    const { container } = render(<WorkspaceCanvas {...props} />);

    expect(container.querySelectorAll('.agent-chat-panel')).toHaveLength(2);
    expect(container.querySelectorAll('[data-browser-native-pane]')).toHaveLength(2);
  });

  it('gives the page only the left column of a card with its agent panel open, without measuring the DOM', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      const element = this as HTMLElement;
      if (element.classList.contains('canvas-viewport')) return domRect(0, 0, 1200, 800);
      return domRect(0, 0, 0, 0);
    });
    const props = createDefaultProps({ openAgentPanelIds: new Set(['b1']) });
    render(<WorkspaceCanvas {...props} />);

    await waitFor(() => {
      const lastBatch = commitLayoutMock.mock.calls.at(-1)?.[0];
      const first = lastBatch?.items.find((item: { browserId: string }) => item.browserId === 'b1');
      // Body 600 - 2×1 border - 2×16 inset = 566 wide; the chat column keeps 312 of it.
      expect(first?.screenBounds).toEqual({ x: 67, y: 89, width: 254, height: 344 });
      expect(first?.visible).toBe(true);
    });
    expect(measured.mock.contexts.some((element) => (element as HTMLElement).dataset.browserNativePane)).toBe(false);
  });

  it('keeps a locked card at its size and yields a pane too narrow for the page to the chat', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      const element = this as HTMLElement;
      if (element.classList.contains('canvas-viewport')) return domRect(0, 0, 1200, 800);
      return domRect(0, 0, 0, 0);
    });
    const locked = createMockBrowser('b1', { worldRect: { x: 50, y: 50, width: 400, height: 400 }, positionLocked: true });
    const props = createDefaultProps({ snapshot: createMockSnapshot([locked]) });
    const { container, rerender } = render(<WorkspaceCanvas {...props} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label^="Abrir agente"]')!);
    expect(props.onUpdateBrowserRects).not.toHaveBeenCalled();
    expect(props.onAgentPanelOpenChange).toHaveBeenCalledWith('b1', true);

    rerender(<WorkspaceCanvas {...props} openAgentPanelIds={new Set(['b1'])} />);
    await waitFor(() => {
      const lastBatch = commitLayoutMock.mock.calls.at(-1)?.[0];
      expect(lastBatch?.items.find((item: { browserId: string }) => item.browserId === 'b1')?.visible).toBe(false);
    });
  });
});
