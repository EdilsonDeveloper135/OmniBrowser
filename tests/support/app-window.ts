import { expect, type ElectronApplication, type Page } from '@playwright/test';

export const E2E_WINDOW_SIZE = { width: 1440, height: 900 } as const;

/**
 * Brings the shell window to the front at a known content size and waits until the main process and the renderer agree
 * on it and the page is visible. Hosted macOS runners have small virtual displays whose size varies between jobs;
 * automated runs may exceed the screen (see `enableLargerThanScreen` in src/main/index.ts), so geometry assertions never
 * depend on the runner. A failure reports the display work area instead of surfacing later as a misaligned card.
 */
export async function setShellWindowSize(app: ElectronApplication, shell: Page, size: { width: number; height: number } = E2E_WINDOW_SIZE): Promise<void> {
  const workArea = await app.evaluate(({ BrowserWindow, screen }, requested) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('The OmniBrowser window does not exist.');
    window.show();
    window.focus();
    window.setContentSize(requested.width, requested.height, false);
    return screen.getDisplayMatching(window.getBounds()).workArea;
  }, size);
  await expect.poll(async () => {
    const [contentSize, renderer] = await Promise.all([
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getContentSize() ?? []),
      shell.evaluate(() => ({ size: [innerWidth, innerHeight], visibility: document.visibilityState }))
    ]);
    return { contentSize, ...renderer };
  }, {
    message: `the shell window should be ${size.width}×${size.height} and visible (display work area ${workArea.width}×${workArea.height})`,
    timeout: 10_000
  }).toEqual({ contentSize: [size.width, size.height], size: [size.width, size.height], visibility: 'visible' });
}
