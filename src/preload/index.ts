import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { OmniBrowserApi, OmniEvent } from '../shared/contracts';
import type { IpcResult } from '../shared/errors';

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = await ipcRenderer.invoke(channel, payload) as IpcResult<T>;
  if (result.ok) return result.value;
  // Only the message crosses the context bridge; it is already localized and free of implementation details.
  throw new Error(result.error.message);
}

const api: OmniBrowserApi = {
  bootstrap: () => invoke(IPC_CHANNELS.bootstrap),
  profiles: {
    list: () => invoke(IPC_CHANNELS.profilesList),
    createPersistent: (name) => invoke(IPC_CHANNELS.profilesCreatePersistent, { name }),
    createPrivate: (name) => invoke(IPC_CHANNELS.profilesCreatePrivate, { name })
  },
  browsers: {
    create: (profileId) => invoke(IPC_CHANNELS.browsersCreate, { profileId }),
    close: (browserId) => invoke(IPC_CHANNELS.browsersClose, { browserId }),
    duplicate: (browserIds) => invoke(IPC_CHANNELS.browsersDuplicate, { browserIds }),
    assignProfile: (browserId, profileId) => invoke(IPC_CHANNELS.browsersAssignProfile, { browserId, profileId }),
    setPresentation: (browserIds, presentation) => invoke(IPC_CHANNELS.browsersSetPresentation, { browserIds, presentation }),
    setPositionLocked: (browserIds, locked) => invoke(IPC_CHANNELS.browsersSetPositionLocked, { browserIds, locked }),
    setSidebarPinned: (browserIds, pinned) => invoke(IPC_CHANNELS.browsersSetSidebarPinned, { browserIds, pinned }),
    setViewportPin: (browserId, viewport) => invoke(IPC_CHANNELS.browsersSetViewportPin, { browserId, viewport }),
    navigate: (browserId, url) => invoke(IPC_CHANNELS.browsersNavigate, { browserId, url }),
    back: (browserId) => invoke(IPC_CHANNELS.browsersBack, { browserId }),
    forward: (browserId) => invoke(IPC_CHANNELS.browsersForward, { browserId }),
    reload: (browserId) => invoke(IPC_CHANNELS.browsersReload, { browserId }),
    stop: (browserId) => invoke(IPC_CHANNELS.browsersStop, { browserId }),
    focus: (browserId, options) => invoke(IPC_CHANNELS.browsersFocus, options?.focusContents === undefined ? { browserId } : { browserId, focusContents: options.focusContents }),
    sleep: (browserId) => invoke(IPC_CHANNELS.browsersSleep, { browserId }),
    wake: (browserId) => invoke(IPC_CHANNELS.browsersWake, { browserId })
  },
  workspace: {
    clearFocus: () => invoke(IPC_CHANNELS.workspaceClearFocus),
    createZone: (profileId, name, color, browserIds) => invoke(IPC_CHANNELS.workspaceCreateZone, { profileId, name, color, browserIds }),
    updateZone: (zoneId, update) => invoke(IPC_CHANNELS.workspaceUpdateZone, { zoneId, ...update }),
    setZoneCollapsed: (zoneId, collapsed) => invoke(IPC_CHANNELS.workspaceSetZoneCollapsed, { zoneId, collapsed }),
    deleteZone: (zoneId) => invoke(IPC_CHANNELS.workspaceDeleteZone, { zoneId }),
    assignZone: (browserIds, zoneId) => invoke(IPC_CHANNELS.workspaceAssignZone, { browserIds, zoneId }),
    createStack: (zoneId, browserIds) => invoke(IPC_CHANNELS.workspaceCreateStack, { zoneId, browserIds }),
    addStackMember: (stackId, browserId) => invoke(IPC_CHANNELS.workspaceAddStackMember, { stackId, browserId }),
    selectStackMember: (stackId, browserId) => invoke(IPC_CHANNELS.workspaceSelectStackMember, { stackId, browserId }),
    unstack: (stackId) => invoke(IPC_CHANNELS.workspaceUnstack, { stackId }),
    setBrowserOrder: (browserOrder) => invoke(IPC_CHANNELS.workspaceSetBrowserOrder, { browserOrder }),
    setPreferences: (update) => invoke(IPC_CHANNELS.workspaceSetPreferences, update),
    commitLayout: (layout) => invoke(IPC_CHANNELS.workspaceCommitLayout, layout),
    setCamera: (camera) => invoke(IPC_CHANNELS.workspaceSetCamera, { camera }),
    saveNow: () => invoke(IPC_CHANNELS.workspaceSaveNow)
  },
  events: {
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: OmniEvent) => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.event, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
    }
  }
};

contextBridge.exposeInMainWorld('omniBrowser', Object.freeze(api));
