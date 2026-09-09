// Finding a browser that can host a chromeless window.
//
// ADR 0005. inkpipe has always been a real desktop application in every way
// except the one the owner could see: it runs on his machine, holds his private
// key, and talks to his local model. It just opened in a browser tab, so it
// never looked like an app, and he said so.
//
// The fix is not a new runtime. Chromium based browsers take `--app=URL`, which
// opens a window with no address bar, no tabs, and its own taskbar entry. Edge
// ships with Windows, so on the target platform this is guaranteed present and
// costs nothing. Electron would add about 150 MB to carry a browser we already
// have, and Tauri would add a Rust toolchain that ADR 0002 removed on purpose.
//
// This module is pure and injectable so the choice can be tested without
// launching anything.

export interface BrowserCandidate {
  name: string;
  path: string;
}

/**
 * Where a Chromium browser lives, best first.
 *
 * Edge is first on Windows because it is guaranteed to be there. Chrome and
 * Brave follow for people who removed Edge or prefer their own.
 */
export function candidatePaths(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): BrowserCandidate[] {
  const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'] ?? '';

  if (platform === 'win32') {
    return [
      { name: 'Microsoft Edge', path: `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Microsoft Edge', path: `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Google Chrome', path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe` },
      { name: 'Google Chrome', path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe` },
      ...(localAppData
        ? [{ name: 'Google Chrome', path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe` }]
        : []),
      { name: 'Brave', path: `${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` },
    ];
  }

  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Brave', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
    ];
  }

  return [
    { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
  ];
}

/** The first candidate that exists, or null when there is no Chromium at all. */
export function findBrowser(
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): BrowserCandidate | null {
  return candidatePaths(platform, env).find((c) => exists(c.path)) ?? null;
}

/**
 * Arguments for a chromeless window.
 *
 * The profile directory is separate on purpose. Without it the window joins the
 * user's ordinary browser session, which means closing their last tab can take
 * inkpipe with it, and it would inherit extensions that can read the page. This
 * page holds decrypted notes, so it gets its own profile.
 */
export function windowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Nothing here should be shared with a browser session or an extension.
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1200,860',
  ];
}
