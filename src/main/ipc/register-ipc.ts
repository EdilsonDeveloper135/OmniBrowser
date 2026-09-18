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
  handle(IPC_CHANNELS.profilesCreatePrivate, (input) => controller.createPrivateProfile(input));
  handle(IPC_CHANNELS.browsersCreate, (input) => controller.createBrowser(input));
  handle(IPC_CHANNELS.browsersClose, (input) => controller.closeBrowser(input));
  handle(IPC_CHANNELS.browsersDuplicate, (input) => controller.duplicateBrowsers(input));
  handle(IPC_CHANNELS.browsersAssignProfile, (input) => controller.assignProfile(input));
  handle(IPC_CHANNELS.browsersSetPresentation, (input) => controller.setPresentation(input));
  handle(IPC_CHANNELS.browsersSetPositionLocked, (input) => controller.setPositionLocked(input));
  handle(IPC_CHANNELS.browsersSetSidebarPinned, (input) => controller.setSidebarPinned(input));
  handle(IPC_CHANNELS.browsersSetViewportPin, (input) => controller.setViewportPin(input));
  handle(IPC_CHANNELS.browsersNavigate, (input) => controller.navigate(input));
  handle(IPC_CHANNELS.browsersBack, (input) => controller.back(input));
  handle(IPC_CHANNELS.browsersForward, (input) => controller.forward(input));
  handle(IPC_CHANNELS.browsersReload, (input) => controller.reload(input));
  handle(IPC_CHANNELS.browsersStop, (input) => controller.stop(input));
  handle(IPC_CHANNELS.browsersFocus, (input) => controller.focus(input));
  handle(IPC_CHANNELS.browsersSleep, (input) => controller.sleep(input));
  handle(IPC_CHANNELS.browsersWake, (input) => controller.wake(input));
  handle(IPC_CHANNELS.workspaceClearFocus, () => controller.clearFocus());
  handle(IPC_CHANNELS.workspaceCreateZone, (input) => controller.createZone(input));
  handle(IPC_CHANNELS.workspaceUpdateZone, (input) => controller.updateZone(input));
  handle(IPC_CHANNELS.workspaceSetZoneCollapsed, (input) => controller.setZoneCollapsed(input));
  handle(IPC_CHANNELS.workspaceDeleteZone, (input) => controller.deleteZone(input));
  handle(IPC_CHANNELS.workspaceAssignZone, (input) => controller.assignZone(input));
  handle(IPC_CHANNELS.workspaceCreateStack, (input) => controller.createStack(input));
  handle(IPC_CHANNELS.workspaceAddStackMember, (input) => controller.addStackMember(input));
  handle(IPC_CHANNELS.workspaceSelectStackMember, (input) => controller.selectStackMember(input));
  handle(IPC_CHANNELS.workspaceUnstack, (input) => controller.unstack(input));
  handle(IPC_CHANNELS.workspaceSetBrowserOrder, (input) => controller.setBrowserOrder(input));
  handle(IPC_CHANNELS.workspaceSetPreferences, (input) => controller.setPreferences(input));
  handle(IPC_CHANNELS.workspaceCommitLayout, (input) => controller.commitLayout(input));
  handle(IPC_CHANNELS.workspaceSetCamera, (input) => controller.setCamera(input));
  handle(IPC_CHANNELS.workspaceSaveNow, () => controller.saveNow());
  handle(IPC_CHANNELS.agentsList, () => controller.listAgents());
  handle(IPC_CHANNELS.agentsGet, (input) => controller.getAgent(input));
  handle(IPC_CHANNELS.agentsSend, (input) => controller.sendAgentInstruction(input));
  handle(IPC_CHANNELS.agentsPause, (input) => controller.pauseAgent(input));
  handle(IPC_CHANNELS.agentsResume, (input) => controller.resumeAgent(input));
  handle(IPC_CHANNELS.agentsStop, (input) => controller.stopAgent(input));
  handle(IPC_CHANNELS.agentsGetProvider, () => controller.getAgentProvider());
  handle(IPC_CHANNELS.agentsSaveProvider, (input) => controller.saveAgentProvider(input));
  handle(IPC_CHANNELS.agentsTestProvider, (input) => controller.testAgentProvider(input));
}
