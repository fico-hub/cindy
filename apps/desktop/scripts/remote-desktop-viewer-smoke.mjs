/** Real Chromium + production Desktop viewer, with a loopback synthetic host.
 * Usage: node apps/desktop/scripts/remote-desktop-viewer-smoke.mjs <Vite origin> <Chrome path> [win32|darwin]
 * No account, OS capture, credential, or remote input. Artifacts live in a unique OS temp dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const origin = new URL(process.argv[2]);
assert(['localhost', '127.0.0.1'].includes(origin.hostname));
const controllerPlatform = process.argv[4] ?? 'win32';
assert(['win32', 'darwin'].includes(controllerPlatform));
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-viewer-smoke-'));
const browser = await chromium.launch({ executablePath: process.argv[3], headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  const host = await context.newPage(),
    viewer = await context.newPage();
  await host.goto(origin.origin);
  await host.setContent('<canvas width="1280" height="720"></canvas>');
  const errors = [];
  viewer.on('pageerror', (e) => errors.push(e.message));
  const requests = [];
  await viewer.exposeFunction('viewerRequest', async (request) => {
    requests.push(request.op);
    switch (request.op) {
      case 'capabilities':
        return {
          version: 1,
          enabled: true,
          canControl: true,
          clipboardText: true,
          automaticReconnect: true,
          videoSettings: true,
          platform: 'win32',
          displays: [{ id: 'one', name: 'Test display', width: 1280, height: 720 }],
        };
      case 'start':
        return {
          lease: 'test-lease',
          controlling: false,
          display: { id: 'one', width: 1280, height: 720 },
        };
      case 'control':
        return { controlling: request.enabled };
      case 'heartbeat':
        return { controlling: true };
      case 'frame':
        return { jpeg: null };
      case 'stop':
        return { ok: true };
      case 'offer':
        return {
          sdp: await host.evaluate(async (sdp) => {
            window.peer?.close();
            clearInterval(window.paint);
            const canvas = document.querySelector('canvas'),
              ctx = canvas.getContext('2d');
            let tick = 0;
            window.paint = setInterval(() => {
              ctx.fillStyle = '#eee';
              ctx.fillRect(0, 0, 1280, 720);
              ctx.fillStyle = '#222';
              ctx.font = '36px sans-serif';
              ctx.fillText('Local WebRTC test · ' + ++tick, 50, 90);
            }, 60);
            const rtc = new RTCPeerConnection({ iceServers: [] });
            window.peer = rtc;
            window.inputs = [];
            const stream = canvas.captureStream(15);
            stream.getTracks().forEach((track) => rtc.addTrack(track, stream));
            rtc.ondatachannel = ({ channel }) => {
              channel.onmessage = ({ data }) => {
                window.inputs.push(...JSON.parse(data).events);
              };
            };
            await rtc.setRemoteDescription({ type: 'offer', sdp });
            await rtc.setLocalDescription(await rtc.createAnswer());
            if (rtc.iceGatheringState !== 'complete')
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 5000);
                rtc.onicegatheringstatechange = () => {
                  if (rtc.iceGatheringState === 'complete') {
                    clearTimeout(timer);
                    resolve();
                  }
                };
              });
            return rtc.localDescription.sdp;
          }, request.sdp),
        };
      default:
        return {};
    }
  });
  await viewer.addInitScript((controllerPlatform) => {
    const noop = () => {},
      off = () => noop;
    const scope = {
      target: { deviceId: 'test-host', name: 'Test computer' },
      generation: 1,
      active: true,
    };
    window.electronAPI = {
      platform: controllerPlatform,
      preferredSystemLocale: 'en',
      logToMain: noop,
      appearanceSettings: { getSync: () => null, onChanged: off },
      localThemes: { listSync: () => ({ success: true, themes: [], diagnostics: [] }) },
      authHasPersistedSessionHintSync: () => true,
      appShortcuts: {
        getState: () => ({ overrides: {}, platform: controllerPlatform }),
        onChanged: off,
      },
      theme: { applyVibrancy: noop },
      getFullscreenState: async () => false,
      onFullscreenChange: off,
      windowMinimize: noop,
      windowMaximize: noop,
      windowClose: noop,
      remoteDesktopViewer: {
        state: async () => scope,
        onActive: off,
        onLocale: (listener) => {
          window.applyViewerLocale = listener;
          return noop;
        },
        rendererReady: async () => {},
        presentationReady: async () => {},
        request: (_generation, request) => window.viewerRequest(request),
        ice: async () => [],
        inputFocus: async () => {},
        close: async () => {},
        fullscreen: async () => {},
        clipboard: async () => {},
      },
    };
  }, controllerPlatform);
  await viewer.goto(new URL('/?remoteDesktopViewer=1', origin.origin).href);
  await viewer.waitForFunction(
    () => document.querySelector('video')?.videoWidth > 0,
    {},
    { timeout: 25000 },
  );
  await viewer.waitForFunction(() => document.querySelector('.remote-viewer-network') !== null);
  const stage = await viewer.locator('#stage').boundingBox();
  assert(stage);
  await viewer.mouse.move(stage.x + 400, stage.y + 300);
  await host.waitForFunction(() => window.inputs.some((event) => event.kind === 'move'));
  await viewer.mouse.down();
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'button' && event.button === 0 && event.down),
  );
  await viewer.mouse.move(stage.x + 520, stage.y + 370, { steps: 5 });
  await viewer.mouse.up();
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'button' && event.button === 0 && !event.down),
  );
  const mouseEvents = await host.evaluate(() => window.inputs);
  const down = mouseEvents.findIndex((event) => event.kind === 'button' && event.down);
  const up = mouseEvents.findIndex(
    (event, index) => index > down && event.kind === 'button' && !event.down,
  );
  assert(
    mouseEvents.slice(down + 1, up).some((event) => event.kind === 'move'),
    'drag moves reach the host while the button is held',
  );
  assert(
    !mouseEvents.slice(down + 1, up).some((event) => event.kind === 'release'),
    'focus does not cancel a held mouse button',
  );
  await viewer.keyboard.type('desktop');
  await host.waitForFunction(() =>
    window.inputs.some((event) => event.kind === 'text' && event.text.includes('d')),
  );
  await viewer.screenshot({ path: path.join(artifacts, 'light.png') });
  await viewer.evaluate(async () => {
    const { themeService } = await import('/themes/theme-service.ts');
    const { cindyDark } = await import('/themes/builtin/cindy-dark.ts');
    themeService.applyTheme(cindyDark);
  });
  await viewer.screenshot({ path: path.join(artifacts, 'dark.png') });
  await host.evaluate(() => window.peer.close());
  await viewer.waitForFunction(
    () => document.querySelector('.remote-viewer-network')?.textContent.includes('Compatibility'),
    {},
    { timeout: 12000 },
  );
  await viewer.waitForFunction(
    () => document.querySelector('.remote-viewer-network')?.textContent.includes('Direct'),
    {},
    { timeout: 25000 },
  );
  assert.equal(
    requests.filter((op) => op === 'start').length,
    1,
    'media recovery must retain its lease',
  );
  assert.deepEqual(errors, []);
  await viewer.evaluate(() => window.applyViewerLocale('zh-CN'));
  await viewer.getByRole('button', { name: '操作', exact: true }).click();
  const settings = viewer.getByRole('complementary', { name: '操作' });
  await settings.locator('label').filter({ hasText: '帧率' }).waitFor();
  assert(
    !/\?{2,}|\uFFFD/u.test(await settings.innerText()),
    'Chinese settings must remain readable',
  );
  await viewer.screenshot({ path: path.join(artifacts, 'settings-zh-dark.png') });
  await viewer.evaluate(async () => {
    const { themeService } = await import('/themes/theme-service.ts');
    const { cindyLight } = await import('/themes/builtin/cindy-light.ts');
    themeService.applyTheme(cindyLight);
  });
  await viewer.screenshot({ path: path.join(artifacts, 'settings-zh-light.png') });
  assert.equal(
    requests.filter((op) => op === 'start').length,
    1,
    'locale updates retain the desktop lease',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      video: true,
      keyboard: true,
      mouse: true,
      controllerPlatform,
      mediaRecovery: true,
      chineseSettings: true,
      localeKeepsLease: true,
      lightDarkArtifacts: artifacts,
    }),
  );
} finally {
  await browser.close();
}
