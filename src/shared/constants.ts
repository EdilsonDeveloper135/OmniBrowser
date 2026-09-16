export const APP_NAME = 'OmniBrowser';
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const INTERACTIVE_ZOOM_THRESHOLD = 0.5;
export const MIN_BROWSER_WIDTH = 320;
export const MIN_BROWSER_HEIGHT = 240;
export const CARD_HEADER_HEIGHT = 38;
export const PROFILE_RAIL_WIDTH = 218;
export const TOOLBAR_HEIGHT = 60;
export const STATUS_BAR_HEIGHT = 28;
export const DEFAULT_BROWSER_URL = 'about:blank';
export const MAX_BROWSER_COUNT_PER_LAYOUT_BATCH = 500;

export const IPC_CHANNELS = {
  bootstrap: 'omni:bootstrap',
  profilesList: 'omni:profiles:list',
  profilesCreatePersistent: 'omni:profiles:create-persistent',
  profilesCreateTemporary: 'omni:profiles:create-temporary',
  browsersCreate: 'omni:browsers:create',
  browsersClose: 'omni:browsers:close',
  browsersAssignProfile: 'omni:browsers:assign-profile',
  browsersNavigate: 'omni:browsers:navigate',
  browsersBack: 'omni:browsers:back',
  browsersForward: 'omni:browsers:forward',
  browsersReload: 'omni:browsers:reload',
  browsersFocus: 'omni:browsers:focus',
  browsersSleep: 'omni:browsers:sleep',
  browsersWake: 'omni:browsers:wake',
  workspaceCommitLayout: 'omni:workspace:commit-layout',
  workspaceSetCamera: 'omni:workspace:set-camera',
  workspaceSaveNow: 'omni:workspace:save-now',
  event: 'omni:event'
} as const;
