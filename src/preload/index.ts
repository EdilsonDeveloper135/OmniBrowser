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
    createTemporary: (name) => invoke(IPC_CHANNELS.profilesCreateTemporary, { name })
  },
  browsers: {
    create: (profileId) => invoke(IPC_CHANNELS.browsersCreate, { profileId }),
    close: (browserId) => invoke(IPC_CHANNELS.browsersClose, { browserId }),
    assignProfile: (browserId, profileId) => invoke(IPC_CHANNELS.browsersAssignProfile, { browserId, profileId }),
    navigate: (browserId, url) => invoke(IPC_CHANNELS.browsersNavigate, { browserId, url }),
    back: (browserId) => invoke(IPC_CHANNELS.browsersBack, { browserId }),
    forward: (browserId) => invoke(IPC_CHANNELS.browsersForward, { browserId }),
    reload: (browserId) => invoke(IPC_CHANNELS.browsersReload, { browserId }),
    focus: (browserId, options) => invoke(IPC_CHANNELS.browsersFocus, options?.focusContents === undefined ? { browserId } : { browserId, focusContents: options.focusContents }),
    sleep: (browserId) => invoke(IPC_CHANNELS.browsersSleep, { browserId }),
    wake: (browserId) => invoke(IPC_CHANNELS.browsersWake, { browserId })
  },
  workspace: {
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
