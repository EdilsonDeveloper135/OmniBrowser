import type {
  BrowserSnapshot,
  Camera,
  LayoutBatch,
  ProfileRecord,
  WorkspaceSnapshot
} from './schemas';

export type OmniEvent =
  | { type: 'workspace-snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'browser-state'; browser: BrowserSnapshot }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'save-status'; status: WorkspaceSnapshot['saveStatus'] };

export interface OmniBrowserApi {
  bootstrap(): Promise<WorkspaceSnapshot>;
  profiles: {
    list(): Promise<ProfileRecord[]>;
    createPersistent(name: string): Promise<WorkspaceSnapshot>;
    createTemporary(name: string): Promise<WorkspaceSnapshot>;
  };
  browsers: {
    create(profileId: string): Promise<WorkspaceSnapshot>;
    close(browserId: string): Promise<WorkspaceSnapshot>;
    assignProfile(browserId: string, profileId: string): Promise<WorkspaceSnapshot>;
    navigate(browserId: string, url: string): Promise<void>;
    back(browserId: string): Promise<void>;
    forward(browserId: string): Promise<void>;
    reload(browserId: string): Promise<void>;
    focus(browserId: string, options?: { focusContents?: boolean }): Promise<WorkspaceSnapshot>;
    sleep(browserId: string): Promise<WorkspaceSnapshot>;
    wake(browserId: string): Promise<WorkspaceSnapshot>;
  };
  workspace: {
    commitLayout(layout: LayoutBatch): Promise<void>;
    setCamera(camera: Camera): Promise<void>;
    saveNow(): Promise<void>;
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
