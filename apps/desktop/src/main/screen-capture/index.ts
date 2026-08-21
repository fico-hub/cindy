import { ipcMain } from 'electron';
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

/**
 * 区域截图(capture-region 快捷键)的 main 侧实现。
 *
 * 仅 darwin: 选区 UI 直接复用系统的 /usr/sbin/screencapture -i(拉框/按窗口,
 * Esc 取消), 不自绘覆盖层 —— 选区交互、多显示器、Retina 缩放都由系统处理。
 * 成功后从临时文件读回 PNG 字节返回 renderer, renderer 走剪贴板图片粘贴
 * 管线进 composer。首次使用时 macOS 可能弹出「屏幕录制」权限授权。
 */

const execFileAsync = promisify(execFile);
const logger = createLogger('screen-capture');

const SCREENCAPTURE_BIN = '/usr/sbin/screencapture';
/** 选区是用户交互, 可能停留很久; 只兜底清理彻底挂死的进程。 */
const CAPTURE_TIMEOUT_MS = 180_000;

/** 进行中去重: 重复按快捷键不再叠加第二个系统选区。 */
let captureInFlight = false;

async function captureRegionToPng(): Promise<ScreenCaptureRegionResult> {
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
    return { ok: true, cancelled: true };
  }
  let data: Buffer;
  try {
    data = await readFile(tmpPath);
  } catch {
    // 退出码 0 但没有文件 —— 某些取消路径也会这样, 按取消处理。
    return { ok: true, cancelled: true };
  } finally {
    void rm(tmpPath, { force: true }).catch(() => {});
  }
  if (data.length === 0) {
    throwIpcError('INTERNAL', 'screencapture produced an empty file');
  }
  return { ok: true, cancelled: false, data };
}

export function registerScreenCaptureIpc(platform: string = process.platform): void {
  ipcMain.handle(SCREEN_CAPTURE_REGION_CHANNEL, async (event): Promise<ScreenCaptureRegionResult> => {
    assertTrustedAppRendererEvent(event);
    if (platform !== 'darwin') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'region capture is only available on macOS');
    }
    if (captureInFlight) {
      return { ok: true, cancelled: true };
    }
    captureInFlight = true;
    try {
      return await captureRegionToPng();
    } finally {
      captureInFlight = false;
    }
  });
}
