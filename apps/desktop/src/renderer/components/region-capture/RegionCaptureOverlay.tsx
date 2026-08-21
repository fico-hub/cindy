import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ScreenCaptureOverlayResult } from '../../../shared/screenCapture';
import { normalizeSelectionRect, type SelectionPoint } from './regionCaptureSelection';

/**
 * win/linux 区域截图选区覆盖层(?view=region-capture-overlay 窗口的根组件)。
 *
 * main(overlayCapture)已把光标所在显示器冻结成 PNG 经 onInit 送达; 本组件
 * 全屏展示冻结帧, 用户拖框选区(暗色遮罩 + 尺寸标签), 松手回报 select,
 * Esc / 右键 / 失焦回报 cancel。坐标全程为覆盖层窗口内 DIP, 像素换算由
 * main 按显示器 scaleFactor 完成。
 */
export function RegionCaptureOverlay() {
  const { t } = useTranslation();
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<SelectionPoint | null>(null);
  const [dragCurrent, setDragCurrent] = useState<SelectionPoint | null>(null);
  const reportedRef = useRef(false);

  const report = useCallback((result: ScreenCaptureOverlayResult) => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    window.electronAPI.screenCaptureOverlay.reportResult(result);
  }, []);

  useEffect(() => {
    const dispose = window.electronAPI.screenCaptureOverlay.onInit((payload) => {
      setImageDataUrl(payload.imageDataUrl);
    });
    // 先订阅再声明就绪 —— main 收到 ready 才发冻结帧, 消除挂载竞态。
    window.electronAPI.screenCaptureOverlay.announceReady();
    return dispose;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') report({ kind: 'cancel' });
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      report({ kind: 'cancel' });
    };
    // 失焦取消(切走窗口/Alt-Tab)。挂载初期部分 WM 会先派发一次瞬时 blur,
    // 给 300ms 宽限避免覆盖层刚出现就自取消。
    const mountedAt = performance.now();
    const onBlur = () => {
      if (performance.now() - mountedAt < 300) return;
      report({ kind: 'cancel' });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
    };
  }, [report]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ x: event.clientX, y: event.clientY });
    setDragCurrent({ x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    setDragCurrent({ x: event.clientX, y: event.clientY });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart) return;
    const rect = normalizeSelectionRect(
      dragStart,
      { x: event.clientX, y: event.clientY },
      { width: window.innerWidth, height: window.innerHeight },
    );
    // 误点(近乎零面积)按取消; 阈值判定在 main 侧统一执行, 这里原样上报。
    report({ kind: 'select', rect });
  };

  const selection =
    dragStart && dragCurrent
      ? normalizeSelectionRect(dragStart, dragCurrent, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      : null;

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden cursor-crosshair"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {imageDataUrl ? (
        // 冻结帧铺满覆盖层(窗口即显示器 bounds, DIP 尺寸一致, 无需缩放计算)。
        <img
          src={imageDataUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full"
        />
      ) : null}
      {selection ? (
        <div
          className="absolute border border-white/90"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            // 选区外暗色遮罩: 超大 box-shadow 一笔完成, 无需四块补丁面板。
            boxShadow: '0 0 0 100000px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div className="absolute -top-6 left-0 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 bg-black/40">
          <div className="absolute left-1/2 top-8 -translate-x-1/2 rounded-md bg-black/70 px-3 py-1.5 text-[13px] text-white">
            {t('regionCapture.hint')}
          </div>
        </div>
      )}
    </div>
  );
}
