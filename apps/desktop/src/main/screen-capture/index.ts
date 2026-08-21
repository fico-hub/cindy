import { clipboard, ipcMain, nativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  SCREEN_CAPTURE_REGION_CHANNEL,
  type ScreenCaptureRegionResult,
} from '../../shared/screenCapture.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { captureRegionViaOverlay } from './overlayCapture.js';

/**
 * 区域截图(capture-region 快捷键)的 main 侧实现, 三平台生效:
 * - darwin: 系统 /usr/sbin/screencapture -i(拉框/按窗口, Esc 取消), 选区
 *   交互、多显示器、Retina 缩放都由系统处理。首次使用时 macOS 可能弹出
 *   「屏幕录制」权限授权。
 * - win32 / linux: desktopCapturer 冻结帧 + 自绘选区覆盖层(overlayCapture)。
 * 成功后 PNG 字节写系统剪贴板并返回 renderer 合并进当前目标草稿。
 */

const execFileAsync = promisify(execFile);
const logger = createLogger('screen-capture');

const SCREENCAPTURE_BIN = '/usr/sbin/screencapture';
/** 选区是用户交互, 可能停留很久; 只兜底清理彻底挂死的进程/覆盖层。 */
const CAPTURE_TIMEOUT_MS = 180_000;

/** 进行中去重: 重复按快捷键不再叠加第二个选区界面。 */
let captureInFlight = false;

interface RegionCaptureOutcome {
  cancelled: boolean;
  data?: Buffer;
}

async function captureRegionDarwin(): Promise<RegionCaptureOutcome> {
  const tmpPath = path.join(os.tmpdir(), `cindy-region-capture-${randomUUID()}.png`);
  try {
    // -i 交互式选区(拖框或空格切换按窗口); 用户 Esc 取消时非零退出且不产生
    // 文件, 与真实失败(下面读文件抛错)区分开。
    await execFileAsync(SCREENCAPTURE_BIN, ['-i', '-t', 'png', tmpPath], {
      timeout: CAPTURE_TIMEOUT_MS,
    });
  } catch (err) {
    logger.debug('screencapture exited non-zero (usually user cancel)', { err: String(err) });
    // 正常取消不产生文件; 只有 timeout 强杀可能留下已写入的文件, 兜底清掉。
    void rm(tmpPath, { force: true }).catch(() => {});
    return { cancelled: true };
  }
  let data: Buffer;
  try {
    data = await readFile(tmpPath);
  } catch {
    // 退出码 0 但没有文件 —— 某些取消路径也会这样, 按取消处理。
    return { cancelled: true };
  } finally {
    void rm(tmpPath, { force: true }).catch(() => {});
  }
  if (data.length === 0) {
    throwIpcError('INTERNAL', 'screencapture produced an empty file');
  }
  return { cancelled: false, data };
}

async function captureRegion(platform: string): Promise<ScreenCaptureRegionResult> {
  const outcome =
    platform === 'darwin'
      ? await captureRegionDarwin()
      : await captureRegionViaOverlay(CAPTURE_TIMEOUT_MS);
  if (outcome.cancelled || !outcome.data) {
    return { ok: true, cancelled: true };
  }
  // 同步写系统剪贴板(best-effort): 自动贴入只覆盖主区当前对话/新任务草稿,
  // 协同 Worker 输入框、分离侧栏窗口等其它 composer 用户直接粘贴即可,
  // 各自走既有粘贴管线, 不必为每个挂载面单独接线。
  try {
    clipboard.writeImage(nativeImage.createFromBuffer(outcome.data));
  } catch (err) {
    logger.warn('failed to write captured image to clipboard (ignored)', { err: String(err) });
  }
  return { ok: true, cancelled: false, data: outcome.data };
}

export function registerScreenCaptureIpc(platform: string = process.platform): void {
  ipcMain.handle(SCREEN_CAPTURE_REGION_CHANNEL, async (event): Promise<ScreenCaptureRegionResult> => {
    assertTrustedAppRendererEvent(event);
    if (captureInFlight) {
      return { ok: true, cancelled: true };
    }
    captureInFlight = true;
    try {
      return await captureRegion(platform);
    } finally {
      captureInFlight = false;
    }
  });
}
