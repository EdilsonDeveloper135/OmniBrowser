import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import type { OmniBrowserApi, OmniEvent } from '../shared/contracts';

const api: OmniBrowserApi = {
  bootstrap: () => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  profiles: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.profilesList),
    createPersistent: (name) => ipcRenderer.invoke(IPC_CHANNELS.profilesCreatePersistent, { name }),
    createTemporary: (name) => ipcRenderer.invoke(IPC_CHANNELS.profilesCreateTemporary, { name })
  },
  browsers: {
    create: (profileId) => ipcRenderer.invoke(IPC_CHANNELS.browsersCreate, { profileId }),
    close: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersClose, { browserId }),
    assignProfile: (browserId, profileId) => ipcRenderer.invoke(IPC_CHANNELS.browsersAssignProfile, { browserId, profileId }),
    navigate: (browserId, url) => ipcRenderer.invoke(IPC_CHANNELS.browsersNavigate, { browserId, url }),
    back: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersBack, { browserId }),
    forward: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersForward, { browserId }),
    reload: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersReload, { browserId }),
    focus: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersFocus, { browserId }),
    sleep: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersSleep, { browserId }),
    wake: (browserId) => ipcRenderer.invoke(IPC_CHANNELS.browsersWake, { browserId })
  },
  workspace: {
    commitLayout: (layout) => ipcRenderer.invoke(IPC_CHANNELS.workspaceCommitLayout, layout),
    setCamera: (camera) => ipcRenderer.invoke(IPC_CHANNELS.workspaceSetCamera, { camera }),
    saveNow: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveNow)
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
