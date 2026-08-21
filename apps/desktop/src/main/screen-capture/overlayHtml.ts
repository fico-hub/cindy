/**
 * 区域截图选区覆盖层的自包含 HTML 生成器(win/linux)。
 *
 * 页面由 main 生成、经 data: URL 加载, 只依赖专用最小 preload
 * (regionCaptureOverlayPreload)暴露的 ready/init/result 三个方法 —— 不加载
 * 主 renderer bundle, 不承载主窗口 bridge(最小权限, review P1)。样式内嵌
 * raw CSS(sessionDragPreviewHtml 同款形态), 字号 11/13px 落在 DESIGN.md §3
 * 白名单档位内。
 *
 * 交互契约(与 main 侧 overlayCapture 对齐):
 * - DOMContentLoaded → announceReady → 收到 init 后展示冻结帧;
 * - 左键拖框 → mouseup 上报 select(DIP rect, 任意方向拖拽已规整并夹取边界);
 * - Esc / 右键 / 失焦(300ms 挂载宽限) → cancel; 近零选区由 main 判定为误点。
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildRegionCaptureOverlayHtml(hintText: string): string {
  const hint = escapeHtml(hintText);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; background: #000; cursor: crosshair; user-select: none; }
  #frame { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }
  #mask { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.4); }
  #sel { position: absolute; display: none; border: 1px solid rgba(255, 255, 255, 0.9); box-shadow: 0 0 0 100000px rgba(0, 0, 0, 0.4); }
  #size { position: absolute; top: -24px; left: 0; padding: 2px 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.7); color: #fff; font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; }
  #hint { position: absolute; top: 32px; left: 50%; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.7); color: #fff; font-family: system-ui, sans-serif; font-size: 13px; white-space: nowrap; }
</style>
</head>
<body>
<img id="frame" alt="" draggable="false">
<div id="mask"></div>
<div id="sel"><div id="size"></div></div>
<div id="hint">${hint}</div>
<script>
(function () {
  'use strict';
  var api = window.regionCaptureOverlayAPI;
  if (!api) return;
  var frame = document.getElementById('frame');
  var mask = document.getElementById('mask');
  var sel = document.getElementById('sel');
  var size = document.getElementById('size');
  var hint = document.getElementById('hint');
  var reported = false;
  var start = null;

  function report(result) {
    if (reported) return;
    reported = true;
    api.reportResult(result);
  }

  // 拖拽起点/当前点 → 规整选区(任意方向拖拽都得到正宽高), 夹取到窗口边界。
  function rectFrom(a, b) {
    var maxX = window.innerWidth;
    var maxY = window.innerHeight;
    function clamp(v, max) { return Math.min(Math.max(v, 0), max); }
    var x1 = clamp(Math.min(a.x, b.x), maxX);
    var y1 = clamp(Math.min(a.y, b.y), maxY);
    var x2 = clamp(Math.max(a.x, b.x), maxX);
    var y2 = clamp(Math.max(a.y, b.y), maxY);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  function renderSelection(rect) {
    sel.style.display = 'block';
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.width + 'px';
    sel.style.height = rect.height + 'px';
    size.textContent = Math.round(rect.width) + ' \\u00d7 ' + Math.round(rect.height);
    mask.style.display = 'none';
    hint.style.display = 'none';
  }

  api.onInit(function (payload) {
    if (payload && typeof payload.imageDataUrl === 'string') {
      frame.src = payload.imageDataUrl;
      frame.style.display = 'block';
    }
  });

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    renderSelection(rectFrom(start, start));
  });
  document.addEventListener('mousemove', function (e) {
    if (!start) return;
    renderSelection(rectFrom(start, { x: e.clientX, y: e.clientY }));
  });
  document.addEventListener('mouseup', function (e) {
    if (!start) return;
    var rect = rectFrom(start, { x: e.clientX, y: e.clientY });
    start = null;
    report({ kind: 'select', rect: rect });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') report({ kind: 'cancel' });
  });
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    report({ kind: 'cancel' });
  });
  // 失焦取消(切走窗口/Alt-Tab)。挂载初期部分 WM 会派发瞬时 blur, 给宽限。
  var mountedAt = Date.now();
  window.addEventListener('blur', function () {
    if (Date.now() - mountedAt < 300) return;
    report({ kind: 'cancel' });
  });

  api.announceReady();
})();
</script>
</body>
</html>`;
}
