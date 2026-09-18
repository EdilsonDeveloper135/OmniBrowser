// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCard, type BrowserCardActions } from '../../../src/renderer/components/BrowserCard';
import type { BrowserSnapshot, ProfileRecord } from '../../../src/shared/schemas';

afterEach(() => {
  cleanup();
});

const mockProfile: ProfileRecord = {
  id: 'profile-1',
  name: 'Default',
  color: '#2f81f7',
  kind: 'persistent',
  createdAt: '2026-01-01T00:00:00.000Z'
};

function createMockBrowser(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    id: 'browser-1',
    profileId: 'profile-1',
    url: 'https://example.com',
    title: 'Example Domain',
    worldRect: { x: 100, y: 100, width: 800, height: 600 },
    zIndex: 10,
    suspended: false,
    positionLocked: false,
    presentation: 'normal',
    pin: { sidebar: false, viewport: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    zoneId: null,
    runtime: {
      canGoBack: true,
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

function createMockActions(): BrowserCardActions {
  return {
    select: vi.fn(),
    beginMove: vi.fn(),
    beginResize: vi.fn(),
    close: vi.fn(),
    sleep: vi.fn(),
    wake: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    navigate: vi.fn(),
    assignProfile: vi.fn(),
    toggleMinimized: vi.fn(),
    toggleLocked: vi.fn(),
    toggleSidebarPin: vi.fn(),
    toggleViewportPin: vi.fn(),
    duplicate: vi.fn(),
    fullscreen: vi.fn(),
    menuOpenChange: vi.fn(),
    selectStackMember: vi.fn(),
    unstack: vi.fn(),
    toggleAgentPanel: vi.fn(),
    sendAgentInstruction: vi.fn(),
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    stopAgent: vi.fn(),
    openAgentSettings: vi.fn()
  };
}

describe('BrowserCard component', () => {
  it('returns null if profile is not found', () => {
    const browser = createMockBrowser({ profileId: 'unknown-profile' });
    const { container } = render(
      <BrowserCard
        browser={browser}
        profiles={[mockProfile]}
        rect={browser.worldRect}
        surface="world"
        selected={false}
        multiSelected={false}
        stackBrowsers={[]}
        actions={createMockActions()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders card with correct attributes and responds to select', () => {
    const browser = createMockBrowser();
    const actions = createMockActions();
    const { container } = render(
      <BrowserCard
        browser={browser}
        profiles={[mockProfile]}
        rect={browser.worldRect}
        surface="world"
        selected={false}
        multiSelected={false}
        stackBrowsers={[]}
        actions={actions}
      />
    );

    const article = container.querySelector('article.browser-card');
    expect(article).not.toBeNull();
    expect(article?.getAttribute('data-browser-id')).toBe('browser-1');

    fireEvent.pointerDown(article!);
    expect(actions.select).toHaveBeenCalledTimes(1);
  });

  it('renders address bar and navigation buttons when selected', () => {
    const browser = createMockBrowser({
      runtime: {
        canGoBack: true,
        canGoForward: false,
        isLoading: false,
        isAudioPlaying: false,
        crashed: false,
        faviconKey: null,
        download: { activeCount: 0, receivedBytes: 0, totalBytes: null, status: 'idle' },
        lastError: null
      }
    });
    const actions = createMockActions();
    render(
      <BrowserCard
        browser={browser}
        profiles={[mockProfile]}
        rect={browser.worldRect}
        surface="world"
        selected={true}
        multiSelected={false}
        stackBrowsers={[]}
        actions={actions}
      />
    );

    const backButton = screen.getByRole('button', { name: 'Atrás' });
    expect(backButton).not.toBeNull();
    expect((backButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(backButton);
    expect(actions.back).toHaveBeenCalledWith(browser);

    const forwardButton = screen.getByRole('button', { name: 'Adelante' });
    expect((forwardButton as HTMLButtonElement).disabled).toBe(true);

    const reloadButton = screen.getByRole('button', { name: 'Recargar' });
    fireEvent.click(reloadButton);
    expect(actions.reload).toHaveBeenCalledWith(browser);

    const addressInput = screen.getByRole('textbox') as HTMLInputElement;
    expect(addressInput.value).toBe('https://example.com');
    fireEvent.change(addressInput, { target: { value: 'https://newurl.com' } });
    fireEvent.submit(addressInput.closest('form')!);
    expect(actions.navigate).toHaveBeenCalledWith(browser, 'https://newurl.com');
  });

  it('renders minimized card when presentation is minimized in world surface', () => {
    const browser = createMockBrowser({ presentation: 'minimized' });
    const actions = createMockActions();
    const { container } = render(
      <BrowserCard
        browser={browser}
        profiles={[mockProfile]}
        rect={browser.worldRect}
        surface="world"
        selected={false}
        multiSelected={false}
        stackBrowsers={[]}
        actions={actions}
      />
    );

    const minimizedCard = container.querySelector('.minimized-browser-card');
    expect(minimizedCard).not.toBeNull();

    const restoreBtn = screen.getByRole('button', { name: 'Restaurar navegador' });
    fireEvent.click(restoreBtn);
    expect(actions.toggleMinimized).toHaveBeenCalledWith(browser);
  });

  it('opens an isolated agent panel and marks only the native browser pane', () => {
    const browser = createMockBrowser();
    const actions = createMockActions();
    const { container } = render(
      <BrowserCard
        actions={actions}
        agentPanelOpen={true}
        agentSummary={{
          browserId: browser.id,
          agentId: 'agent-1',
          chatSessionId: 'chat-1',
          state: 'running',
          activeTaskId: 'task-1',
          queuedTaskCount: 1,
          sequence: 3,
          updatedAt: '2026-01-01T00:00:00.000Z',
          requiresProvider: false
        }}
        browser={browser}
        multiSelected={false}
        profiles={[mockProfile]}
        rect={browser.worldRect}
        selected={true}
        stackBrowsers={[]}
        surface="world"
      />
    );

    expect(screen.getByLabelText('Agente del navegador browser-1')).not.toBeNull();
    const nativePane = container.querySelector('[data-browser-native-pane="browser-1"]');
    expect(nativePane).not.toBeNull();
    expect(nativePane?.getAttribute('data-browser-content')).toBe('browser-1');
    expect(container.querySelector('.agent-chat-panel')?.hasAttribute('data-browser-native-pane')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Cerrar agente \(Ejecutando\)/ }));
    expect(actions.toggleAgentPanel).toHaveBeenCalledWith(browser);
  });
});
