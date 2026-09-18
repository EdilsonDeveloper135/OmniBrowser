// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCanvas, type WorkspaceCanvasProps } from '../../../src/renderer/components/WorkspaceCanvas';
import type { BrowserSnapshot, ProfileRecord, WorkspaceSnapshot } from '../../../src/shared/schemas';

afterEach(() => {
  cleanup();
});

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

(window as unknown as { omniBrowser: unknown }).omniBrowser = {
  workspace: {
    commitLayout: vi.fn(async () => {})
  }
};

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
});
