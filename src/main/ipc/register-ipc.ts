import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IpcResult } from '../../shared/errors';
import type { OmniBrowserController } from '../app-controller';
import { runIpcAction } from './ipc-result';

function isShellSender(controller: OmniBrowserController, event: IpcMainInvokeEvent): boolean {
  const shell = controller.window.webContents;
  return !shell.isDestroyed() && event.sender === shell && event.senderFrame === shell.mainFrame;
}

export function registerIpc(controller: OmniBrowserController): void {
  const handle = (channel: string, action: (input: unknown) => unknown) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, input): Promise<IpcResult<unknown>> => {
      if (!isShellSender(controller, event)) {
        console.warn(`[omnibrowser] IPC rechazado desde un emisor que no es el shell: ${channel}`);
        return { ok: false, error: { code: 'forbidden', message: 'Operación no permitida.' } };
      }
      return runIpcAction(channel, () => action(input));
    });
  };

  handle(IPC_CHANNELS.bootstrap, () => controller.bootstrap());
  handle(IPC_CHANNELS.profilesList, () => controller.listProfiles());
  handle(IPC_CHANNELS.profilesCreatePersistent, (input) => controller.createPersistentProfile(input));
  handle(IPC_CHANNELS.profilesCreateTemporary, (input) => controller.createTemporaryProfile(input));
  handle(IPC_CHANNELS.browsersCreate, (input) => controller.createBrowser(input));
  handle(IPC_CHANNELS.browsersClose, (input) => controller.closeBrowser(input));
  handle(IPC_CHANNELS.browsersAssignProfile, (input) => controller.assignProfile(input));
  handle(IPC_CHANNELS.browsersNavigate, (input) => controller.navigate(input));
  handle(IPC_CHANNELS.browsersBack, (input) => controller.back(input));
  handle(IPC_CHANNELS.browsersForward, (input) => controller.forward(input));
  handle(IPC_CHANNELS.browsersReload, (input) => controller.reload(input));
  handle(IPC_CHANNELS.browsersFocus, (input) => controller.focus(input));
  handle(IPC_CHANNELS.browsersSleep, (input) => controller.sleep(input));
  handle(IPC_CHANNELS.browsersWake, (input) => controller.wake(input));
  handle(IPC_CHANNELS.workspaceCommitLayout, (input) => controller.commitLayout(input));
  handle(IPC_CHANNELS.workspaceSetCamera, (input) => controller.setCamera(input));
  handle(IPC_CHANNELS.workspaceSaveNow, () => controller.saveNow());
}
