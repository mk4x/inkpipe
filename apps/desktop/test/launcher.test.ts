// The launcher's decisions, without launching anything.
//
// Everything here is about a window that holds decrypted notes, so the
// isolation flags are asserted rather than assumed. A browser window sharing
// the user's ordinary profile would expose those notes to every extension they
// have installed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { candidatePaths, findBrowser, windowArgs } from '../launcher/src/window.ts';

const WIN_ENV = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
};

describe('finding a browser', () => {
  test('Edge comes first on Windows, because it is the one guaranteed to exist', () => {
    const first = candidatePaths('win32', WIN_ENV)[0];
    assert.match(first.path, /msedge\.exe$/);
    assert.equal(first.name, 'Microsoft Edge');
  });

  test('Chrome and Brave are offered for people who removed Edge', () => {
    const names = new Set(candidatePaths('win32', WIN_ENV).map((c) => c.name));
    assert.ok(names.has('Google Chrome'));
    assert.ok(names.has('Brave'));
  });

  test('paths follow the environment rather than being hardcoded', () => {
    // CLAUDE.md rule 2. A machine with Program Files on another drive is
    // common enough, and a hardcoded path simply fails there.
    const paths = candidatePaths('win32', { ...WIN_ENV, PROGRAMFILES: 'D:\\Apps' });
    assert.ok(paths.some((c) => c.path.startsWith('D:\\Apps')));
  });

  test('macOS and Linux get their own candidates', () => {
    assert.ok(candidatePaths('darwin', {}).every((c) => c.path.startsWith('/')));
    assert.ok(candidatePaths('linux', {}).some((c) => c.path.includes('chromium')));
  });

  test('the first browser that exists wins', () => {
    const chosen = findBrowser(
      (path) => path.includes('chrome.exe'),
      'win32',
      WIN_ENV,
    );
    assert.equal(chosen?.name, 'Google Chrome');
  });

  test('no browser at all returns null rather than throwing', () => {
    // Not fatal: the interface still works in an ordinary browser, so this
    // degrades to printing a URL instead of losing the application.
    assert.equal(findBrowser(() => false, 'win32', WIN_ENV), null);
  });
});

describe('the window arguments', () => {
  const url = 'http://127.0.0.1:5272/#token=abc';
  const args = windowArgs(url, 'C:\\profile');

  test('app mode, so there is no address bar and no tabs', () => {
    assert.ok(args.includes(`--app=${url}`));
  });

  test('a separate profile, so the notes are not in the user browser session', () => {
    // Two reasons. Closing their last ordinary tab must not take inkpipe with
    // it, and this page shows decrypted notes so it must not inherit their
    // extensions.
    assert.ok(args.includes('--user-data-dir=C:\\profile'));
    assert.ok(args.includes('--disable-extensions'));
  });

  test('no first run prompts, which would sit in front of the app', () => {
    assert.ok(args.includes('--no-first-run'));
    assert.ok(args.includes('--no-default-browser-check'));
  });

  test('the token travels in the fragment, so it stays out of request logs', () => {
    const appArg = args.find((a) => a.startsWith('--app='))!;
    assert.ok(appArg.includes('#token='));
    assert.ok(!appArg.includes('?token='), 'a query string would reach the server logs');
  });

  test('the window is bound to loopback', () => {
    const appArg = args.find((a) => a.startsWith('--app='))!;
    assert.match(appArg, /127\.0\.0\.1/);
  });
});
