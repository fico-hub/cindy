/**
 * 区域截图(capture-region 快捷键)的 IPC 契约 — main / preload / renderer 共用。
 *
 * renderer → main "调起系统区域截图, 把 PNG 字节返回给我"。捕获必须发生在
 * main: 选区 UI 由 macOS 系统的 /usr/sbin/screencapture -i 提供(spawn 子进程
 * 是 main 的能力), renderer 拿到字节后走 addClipboardImage 复用剪贴板图片
 * 粘贴管线进 composer 附件。
 */
export const SCREEN_CAPTURE_REGION_CHANNEL = 'screen-capture:region';

export interface ScreenCaptureRegionResult {
  ok: true;
  /**
   * 用户取消选区(Esc), 或已有一次选区进行中被去重时为 true — 都不算错误,
   * renderer 静默返回即可。
   */
  cancelled: boolean;
  /** PNG 字节(cancelled 为 false 时存在)。Buffer 跨 IPC 到 renderer 是 Uint8Array。 */
  data?: Uint8Array;
}
