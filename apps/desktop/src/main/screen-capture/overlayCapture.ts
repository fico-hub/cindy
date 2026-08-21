import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'node:path';

import {
  SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL,
  type ScreenCaptureOverlayInitPayload,
  type ScreenCaptureOverlayResult,
} from '../../shared/screenCapture.js';
import { createLogger } from '../logger.js';

/**
 * win/linux 区域截图: desktopCapturer 冻结光标所在显示器 → 全屏覆盖层窗口
 * (?view=region-capture-overlay, 复用主 renderer bundle 与主 preload)展示
 * 冻结帧 → 用户拖框 → main 按 scaleFactor 裁剪 PNG。
 *
 * darwin 不走本路径(系统 screencapture -i 体验更好且免自绘)。多显示器:
 * v1 只截光标所在显示器。Wayland 下 desktopCapturer 经 xdg-desktop-portal,
 * 系统可能先弹一次共享授权。
 */

const logger = createLogger('screen-capture-overlay');

/** 小于该 DIP 尺寸的"选区"按误点取消处理(与拖拽抖动区分)。 */
const MIN_SELECTION_DIP = 3;

interface OverlayCaptureOutcome {
  cancelled: boolean;
  data?: Buffer;
}

/** 覆盖层是纯本地工具窗口, 拒绝一切导航/弹窗。 */
function lockDownOverlayNavigation(overlay: BrowserWindow): void {
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event) => event.preventDefault());
}

export async function captureRegionViaOverlay(timeoutMs: number): Promise<OverlayCaptureOutcome> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scaleFactor = display.scaleFactor || 1;
  const pixelSize = {
    width: Math.round(display.size.width * scaleFactor),
    height: Math.round(display.size.height * scaleFactor),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: pixelSize,
  });
  const source =
    sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null;
  const frame = source?.thumbnail ?? null;
  if (!frame || frame.isEmpty()) {
    throw new Error('desktopCapturer returned no usable screen frame');
  }

  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  lockDownOverlayNavigation(overlay);

  try {
    return await new Promise<OverlayCaptureOutcome>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onResult = (event: Electron.IpcMainEvent, result: ScreenCaptureOverlayResult) => {
        // 只认覆盖层窗口本体; 其它 renderer 无法伪造选区结果。
        if (overlay.isDestroyed() || event.sender.id !== overlay.webContents.id) return;
        if (result?.kind !== 'select') {
          settle(() => resolve({ cancelled: true }));
          return;
        }
        const rect = result.rect;
        const px = {
          x: Math.max(0, Math.round(rect.x * scaleFactor)),
          y: Math.max(0, Math.round(rect.y * scaleFactor)),
          width: Math.round(rect.width * scaleFactor),
          height: Math.round(rect.height * scaleFactor),
        };
        const size = frame.getSize();
        px.width = Math.min(px.width, size.width - px.x);
        px.height = Math.min(px.height, size.height - px.y);
        if (
          rect.width < MIN_SELECTION_DIP ||
          rect.height < MIN_SELECTION_DIP ||
          px.width <= 0 ||
          px.height <= 0
        ) {
          settle(() => resolve({ cancelled: true }));
          return;
        }
        settle(() => resolve({ cancelled: false, data: frame.crop(px).toPNG() }));
      };

      const onClosed = () => settle(() => resolve({ cancelled: true }));
      const timer = setTimeout(
        () => settle(() => resolve({ cancelled: true })),
        timeoutMs,
      );

      // 冻结帧必须等覆盖层 React 组件挂载并订阅后再发(ready 信号驱动):
      // did-finish-load 时组件还在异步挂载, 立即 send 必然发到订阅之前。
      const onReady = (event: Electron.IpcMainEvent) => {
        if (settled || overlay.isDestroyed()) return;
        if (event.sender.id !== overlay.webContents.id) return;
        const payload: ScreenCaptureOverlayInitPayload = {
          imageDataUrl: frame.toDataURL(),
          displaySize: { width: display.size.width, height: display.size.height },
        };
        overlay.webContents.send(SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL, payload);
      };

      const cleanup = () => {
        clearTimeout(timer);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
        overlay.removeListener('closed', onClosed);
      };

      ipcMain.on(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
      ipcMain.on(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
      overlay.on('closed', onClosed);

      const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
        ? (() => {
            const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
            url.searchParams.set('view', 'region-capture-overlay');
            return overlay.loadURL(url.toString());
          })()
        : overlay.loadFile(
            path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
            { query: { view: 'region-capture-overlay' } },
          );
      load
        .then(() => {
          if (settled || overlay.isDestroyed()) return;
          overlay.show();
          overlay.focus();
        })
        .catch((err) => {
          logger.warn('overlay load failed', { err: String(err) });
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
    });
  } finally {
    if (!overlay.isDestroyed()) overlay.destroy();
  }
}
