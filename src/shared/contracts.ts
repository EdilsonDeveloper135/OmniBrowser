import type {
  AgentChatSnapshot,
  AgentProviderInput,
  AgentProviderPublic,
  AgentProviderTestResult,
  AgentSummary,
  AgentTimelineEvent,
  BrowserSnapshot,
  Camera,
  LayoutBatch,
  NormalizedViewportRect,
  ProfileRecord,
  WorkspacePreferences,
  WorkspaceSnapshot
} from './schemas';

export type OmniEvent =
  | { type: 'workspace-snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'browser-state'; browser: BrowserSnapshot }
  | { type: 'native-browser-click'; browserId: string; shiftKey: boolean }
  | { type: 'native-browser-escape'; browserId: string }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'save-status'; status: WorkspaceSnapshot['saveStatus'] }
  | { type: 'agent-state'; summary: AgentSummary }
  | { type: 'agent-event'; event: AgentTimelineEvent };

export interface OmniBrowserApi {
  bootstrap(): Promise<WorkspaceSnapshot>;
  profiles: {
    list(): Promise<ProfileRecord[]>;
    createPersistent(name: string): Promise<WorkspaceSnapshot>;
    createPrivate(name: string): Promise<WorkspaceSnapshot>;
  };
  browsers: {
    create(profileId: string): Promise<WorkspaceSnapshot>;
    close(browserId: string): Promise<WorkspaceSnapshot>;
    duplicate(browserIds: string[]): Promise<WorkspaceSnapshot>;
    assignProfile(browserId: string, profileId: string): Promise<WorkspaceSnapshot>;
    setPresentation(browserIds: string[], presentation: 'normal' | 'minimized'): Promise<WorkspaceSnapshot>;
    setPositionLocked(browserIds: string[], locked: boolean): Promise<WorkspaceSnapshot>;
    setSidebarPinned(browserIds: string[], pinned: boolean): Promise<WorkspaceSnapshot>;
    setViewportPin(browserId: string, viewport: NormalizedViewportRect | null): Promise<WorkspaceSnapshot>;
    navigate(browserId: string, url: string): Promise<void>;
    back(browserId: string): Promise<void>;
    forward(browserId: string): Promise<void>;
    reload(browserId: string): Promise<void>;
    stop(browserId: string): Promise<void>;
    focus(browserId: string, options?: { focusContents?: boolean }): Promise<WorkspaceSnapshot>;
    sleep(browserId: string): Promise<WorkspaceSnapshot>;
    wake(browserId: string): Promise<WorkspaceSnapshot>;
  };
  workspace: {
    clearFocus(): Promise<WorkspaceSnapshot>;
    createZone(profileId: string, name: string, color: string, browserIds: string[]): Promise<WorkspaceSnapshot>;
    updateZone(zoneId: string, update: { name?: string; color?: string }): Promise<WorkspaceSnapshot>;
    setZoneCollapsed(zoneId: string, collapsed: boolean): Promise<WorkspaceSnapshot>;
    deleteZone(zoneId: string): Promise<WorkspaceSnapshot>;
    assignZone(browserIds: string[], zoneId: string | null): Promise<WorkspaceSnapshot>;
    createStack(zoneId: string, browserIds: string[]): Promise<WorkspaceSnapshot>;
    addStackMember(stackId: string, browserId: string): Promise<WorkspaceSnapshot>;
    selectStackMember(stackId: string, browserId: string): Promise<WorkspaceSnapshot>;
    unstack(stackId: string): Promise<WorkspaceSnapshot>;
    setBrowserOrder(browserOrder: string[]): Promise<WorkspaceSnapshot>;
    setPreferences(update: Partial<WorkspacePreferences>): Promise<WorkspaceSnapshot>;
    commitLayout(layout: LayoutBatch): Promise<void>;
    setCamera(camera: Camera): Promise<void>;
    saveNow(): Promise<void>;
  };
  agents: {
    list(): Promise<AgentSummary[]>;
    get(browserId: string): Promise<AgentChatSnapshot>;
    send(browserId: string, instruction: string): Promise<AgentChatSnapshot>;
    pause(browserId: string): Promise<AgentChatSnapshot>;
    resume(browserId: string): Promise<AgentChatSnapshot>;
    stop(browserId: string): Promise<AgentChatSnapshot>;
    getProvider(): Promise<AgentProviderPublic>;
    saveProvider(input: AgentProviderInput): Promise<AgentProviderPublic>;
    testProvider(input: AgentProviderInput): Promise<AgentProviderTestResult>;
  };
  events: {
    subscribe(listener: (event: OmniEvent) => void): () => void;
  };
}

declare global {
  interface Window {
    omniBrowser: OmniBrowserApi;
  }
}

export {};
