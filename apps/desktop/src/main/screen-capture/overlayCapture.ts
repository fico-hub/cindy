import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron';
import path from 'node:path';

import {
  SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL,
  type ScreenCaptureOverlayInitPayload,
  type ScreenCaptureOverlayPalette,
  type ScreenCaptureOverlayRect,
  type ScreenCaptureOverlayResult,
} from '../../shared/screenCapture.js';
import { createLogger } from '../logger.js';
import { buildRegionCaptureOverlayHtml } from './overlayHtml.js';

/**
 * win/linux 区域截图: desktopCapturer 冻结光标所在显示器 → 全屏覆盖层窗口
 * 展示冻结帧 → 用户拖框 → main 按 scaleFactor 裁剪 PNG。
 *
 * 覆盖层是 main 自生成 HTML(overlayHtml, data: URL 加载) + 专用最小 preload
 * (regionCaptureOverlayPreload, 只暴露 ready/init/result), 不加载主 renderer
 * bundle 也不承载主窗口 bridge —— 一次性选区窗口按最小权限隔离(review P1)。
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

/**
 * overlay → main 的选区结果运行时校验。IPC 不保留 TS 类型约束, 且本监听器
 * 在 ipcMain.on 里同步执行 —— 未捕获异常会被 lifecycle 视为 fatal 退出应用,
 * 必须先校验结构与有限数值再做任何算术/裁剪(review P1)。
 */
function parseOverlayResult(value: unknown): ScreenCaptureOverlayResult | null {
  if (!value || typeof value !== 'object') return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'cancel') return { kind: 'cancel' };
  if (kind !== 'select') return null;
  const rect = (value as { rect?: unknown }).rect;
  if (!rect || typeof rect !== 'object') return null;
  const { x, y, width, height } = rect as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return {
    kind: 'select',
    rect: { x, y, width, height } as ScreenCaptureOverlayRect,
  };
}

export async function captureRegionViaOverlay(
  timeoutMs: number,
  hintText: string,
  palette: ScreenCaptureOverlayPalette,
): Promise<OverlayCaptureOutcome> {
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
  // 帧源必须能可靠对应到覆盖层所在显示器: display_id 匹配, 或全局唯一源
  // (单显示器/后端合并输出)。多源且无匹配(部分 Linux/Wayland 后端不回
  // display_id)时不猜 —— 覆盖层在 A 屏展示 B 屏内容会让用户在不知情中
  // 附上另一块屏幕的画面, 宁可失败走 renderer 的失败提示(review P1)。
  const matched = sources.find((s) => s.display_id === String(display.id)) ?? null;
  const source = matched ?? (sources.length === 1 ? sources[0] : null);
  if (!source) {
    throw new Error('cannot match a capture source to the active display');
  }
  const frame = source.thumbnail ?? null;
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
      preload: path.join(__dirname, 'regionCaptureOverlayPreload.js'),
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

      const onResult = (event: Electron.IpcMainEvent, rawResult: unknown) => {
        // 只认覆盖层窗口本体; 其它 renderer 无法伪造选区结果。
        if (overlay.isDestroyed() || event.sender.id !== overlay.webContents.id) return;
        const result = parseOverlayResult(rawResult);
        if (!result || result.kind !== 'select') {
          // 取消, 或非法 payload(被注入的覆盖层已不可信)→ 一律安全拒绝。
          settle(() => resolve({ cancelled: true }));
          return;
        }
        const rect = result.rect;
        const size = frame.getSize();
        const px = {
          x: Math.max(0, Math.round(rect.x * scaleFactor)),
          y: Math.max(0, Math.round(rect.y * scaleFactor)),
          width: Math.round(rect.width * scaleFactor),
          height: Math.round(rect.height * scaleFactor),
        };
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

      // 冻结帧等覆盖层脚本 announceReady 后再发 —— 避免加载完成与监听注册
      // 之间的发送竞态(先发必丢)。
      const onReady = (event: Electron.IpcMainEvent) => {
        if (settled || overlay.isDestroyed()) return;
        if (event.sender.id !== overlay.webContents.id) return;
        const payload: ScreenCaptureOverlayInitPayload = {
          imageDataUrl: frame.toDataURL(),
          displaySize: { width: display.size.width, height: display.size.height },
        };
        overlay.webContents.send(SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL, payload);
      };

      // show() 等冻结帧 <img> 解码完成(loadURL resolve 只代表 HTML 加载完,
      // init 经 IPC 送达 + 大分辨率帧解码都在其后) —— 否则全屏置顶窗口先以
      // 纯黑出现, 用户可能在看不到屏幕内容时就开始选区(review P2)。解码
      // 失败由覆盖层报 cancel, 一直不就绪则由总超时兜底取消。
      const onContentReady = (event: Electron.IpcMainEvent) => {
        if (settled || overlay.isDestroyed()) return;
        if (event.sender.id !== overlay.webContents.id) return;
        overlay.show();
        overlay.focus();
      };

      const cleanup = () => {
        clearTimeout(timer);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
        ipcMain.removeListener(SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL, onContentReady);
        overlay.removeListener('closed', onClosed);
      };

      ipcMain.on(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, onResult);
      ipcMain.on(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL, onReady);
      ipcMain.on(SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL, onContentReady);
      overlay.on('closed', onClosed);

      const html = buildRegionCaptureOverlayHtml(hintText, palette);
      overlay
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .catch((err) => {
          logger.warn('overlay load failed', { err: String(err) });
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
    });
  } finally {
    if (!overlay.isDestroyed()) overlay.destroy();
  }
}
