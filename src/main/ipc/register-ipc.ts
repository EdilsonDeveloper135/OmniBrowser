import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { OmniBrowserController } from '../app-controller';

function assertShellSender(controller: OmniBrowserController, event: IpcMainInvokeEvent): void {
  if (event.sender !== controller.window.webContents || event.senderFrame !== controller.window.webContents.mainFrame) {
    throw new Error('Rejected IPC from a non-shell WebContents.');
  }
}

export function registerIpc(controller: OmniBrowserController): void {
  const handle = (channel: string, action: (input: unknown) => unknown | Promise<unknown>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, input) => {
      assertShellSender(controller, event);
      return action(input);
    });
  };
  const handleWithoutInput = (channel: string, action: () => unknown | Promise<unknown>) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event) => {
      assertShellSender(controller, event);
      return action();
    });
  };

  handleWithoutInput(IPC_CHANNELS.bootstrap, () => controller.bootstrap());
  handleWithoutInput(IPC_CHANNELS.profilesList, () => controller.listProfiles());
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
  handleWithoutInput(IPC_CHANNELS.workspaceSaveNow, () => controller.saveNow());
}
