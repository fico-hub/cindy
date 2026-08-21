import type { ScreenCaptureOverlayRect } from '../../../shared/screenCapture';

export interface SelectionPoint {
  x: number;
  y: number;
}

/**
 * 拖拽起点/当前点 → 规整选区(任意方向拖拽都得到正宽高), 并夹取到覆盖层
 * 边界内。纯函数, 供覆盖层组件与单测共用。
 */
export function normalizeSelectionRect(
  start: SelectionPoint,
  current: SelectionPoint,
  bounds: { width: number; height: number },
): ScreenCaptureOverlayRect {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const x1 = clamp(Math.min(start.x, current.x), bounds.width);
  const y1 = clamp(Math.min(start.y, current.y), bounds.height);
  const x2 = clamp(Math.max(start.x, current.x), bounds.width);
  const y2 = clamp(Math.max(start.y, current.y), bounds.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
