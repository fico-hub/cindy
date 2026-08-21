/**
 * 区域截图(capture-region 快捷键)的 IPC 契约 — main / preload / renderer 共用。
 *
 * renderer → main "调起系统区域截图, 把 PNG 字节返回给我"。捕获必须发生在
 * main: 选区 UI 由 macOS 系统的 /usr/sbin/screencapture -i 提供(spawn 子进程
 * 是 main 的能力)。成功时 main 同时把图片写入系统剪贴板(其它 composer 可
 * 直接 ⌘V), renderer 拿到字节后合并进当前目标草稿。
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

// ── win/linux 自绘选区覆盖层(?view=region-capture-overlay 窗口)的通道 ──
// darwin 走系统 screencapture -i, 无覆盖层。流程: main 用 desktopCapturer
// 冻结光标所在显示器 → 开全屏覆盖层窗口展示冻结帧 → 用户拖框/Esc → 覆盖层
// 经 result 通道回报 → main 按 scaleFactor 裁剪出 PNG。

/** overlay → main: 覆盖层 React 组件挂载完成、已订阅 init —— main 收到后再发
 *  冻结帧, 避免 did-finish-load 与组件异步挂载间的发送竞态(先发必丢)。 */
export const SCREEN_CAPTURE_OVERLAY_READY_CHANNEL = 'screen-capture:overlay-ready';
/** main → overlay: 冻结帧与选区坐标系初始化。 */
export const SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL = 'screen-capture:overlay-init';
/** overlay → main: 选区结果(main 侧校验 sender 必须是覆盖层窗口本体)。 */
export const SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL = 'screen-capture:overlay-result';

export interface ScreenCaptureOverlayInitPayload {
  /** 冻结屏幕帧(光标所在显示器, 像素分辨率)的 data:image/png URL。 */
  imageDataUrl: string;
  /** 覆盖层窗口的 DIP 尺寸 —— 选区 rect 的坐标系。 */
  displaySize: { width: number; height: number };
}

/** 选区 rect: 覆盖层窗口内 DIP 坐标。 */
export interface ScreenCaptureOverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenCaptureOverlayResult =
  | { kind: 'cancel' }
  | { kind: 'select'; rect: ScreenCaptureOverlayRect };
