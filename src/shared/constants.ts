export const APP_NAME = 'OmniBrowser';
export const WORKSPACE_SCHEMA_VERSION = 2 as const;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const INTERACTIVE_ZOOM_THRESHOLD = 0.5;
export const MIN_BROWSER_WIDTH = 320;
export const MIN_BROWSER_HEIGHT = 240;
export const MINIMIZED_BROWSER_WIDTH = 220;
export const MINIMIZED_BROWSER_HEIGHT = 52;
export const ZONE_PADDING = 28;
export const SNAP_THRESHOLD_PX = 8;
export const CARD_HEADER_HEIGHT = 38;
// Must match .browser-card (border) and .browser-content-slot (inset) in styles.css; a unit test enforces it.
export const CARD_BORDER_WIDTH = 1;
export const CARD_CONTENT_INSET = { top: CARD_HEADER_HEIGHT, right: 16, bottom: 16, left: 16 } as const;
// Resize handles and the selection ring extend this far outside a card, in world units.
export const CARD_CHROME_OVERFLOW = 5;
// Must match .minimap in styles.css.
export const MINIMAP_SIZE = { width: 160, height: 104 } as const;
export const MINIMAP_MARGIN = 14;
export const ZOOM_STEP = 0.1;
export const MAX_CAMERA_PAN = 1_000_000;
export const MAX_WORLD_COORDINATE = 1_000_000;
export const MAX_WORLD_SIZE = 100_000;
export const MAX_SCREEN_COORDINATE = 100_000;
export const MAX_SCREEN_SIZE = 20_000;
export const PROFILE_RAIL_WIDTH = 280;
export const TOOLBAR_HEIGHT = 60;
export const STATUS_BAR_HEIGHT = 28;
export const DEFAULT_BROWSER_URL = 'about:blank';
export const MAX_URL_LENGTH = 4096;
export const MAX_TITLE_LENGTH = 512;
export const MAX_HISTORY_ENTRIES = 500;
export const MAX_BROWSER_COUNT_PER_LAYOUT_BATCH = 500;

export const IPC_CHANNELS = {
  bootstrap: 'omni:bootstrap',
  profilesList: 'omni:profiles:list',
  profilesCreatePersistent: 'omni:profiles:create-persistent',
  profilesCreatePrivate: 'omni:profiles:create-private',
  browsersCreate: 'omni:browsers:create',
  browsersClose: 'omni:browsers:close',
  browsersDuplicate: 'omni:browsers:duplicate',
  browsersAssignProfile: 'omni:browsers:assign-profile',
  browsersSetPresentation: 'omni:browsers:set-presentation',
  browsersSetPositionLocked: 'omni:browsers:set-position-locked',
  browsersSetSidebarPinned: 'omni:browsers:set-sidebar-pinned',
  browsersSetViewportPin: 'omni:browsers:set-viewport-pin',
  browsersNavigate: 'omni:browsers:navigate',
  browsersBack: 'omni:browsers:back',
  browsersForward: 'omni:browsers:forward',
  browsersReload: 'omni:browsers:reload',
  browsersStop: 'omni:browsers:stop',
  browsersFocus: 'omni:browsers:focus',
  browsersSleep: 'omni:browsers:sleep',
  browsersWake: 'omni:browsers:wake',
  workspaceClearFocus: 'omni:workspace:clear-focus',
  workspaceCreateZone: 'omni:workspace:create-zone',
  workspaceUpdateZone: 'omni:workspace:update-zone',
  workspaceSetZoneCollapsed: 'omni:workspace:set-zone-collapsed',
  workspaceDeleteZone: 'omni:workspace:delete-zone',
  workspaceAssignZone: 'omni:workspace:assign-zone',
  workspaceCreateStack: 'omni:workspace:create-stack',
  workspaceAddStackMember: 'omni:workspace:add-stack-member',
  workspaceSelectStackMember: 'omni:workspace:select-stack-member',
  workspaceUnstack: 'omni:workspace:unstack',
  workspaceSetBrowserOrder: 'omni:workspace:set-browser-order',
  workspaceSetPreferences: 'omni:workspace:set-preferences',
  workspaceCommitLayout: 'omni:workspace:commit-layout',
  workspaceSetCamera: 'omni:workspace:set-camera',
  workspaceSaveNow: 'omni:workspace:save-now',
  event: 'omni:event'
} as const;
