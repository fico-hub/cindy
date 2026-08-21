import { describe, expect, it } from 'vitest';

import { buildRegionCaptureOverlayHtml } from '../overlayHtml.js';

describe('buildRegionCaptureOverlayHtml', () => {
  it('embeds the hint text and the overlay API contract', () => {
    const html = buildRegionCaptureOverlayHtml('拖动框选要截取的区域，按 Esc 取消');
    expect(html).toContain('拖动框选要截取的区域，按 Esc 取消');
    expect(html).toContain('regionCaptureOverlayAPI');
    expect(html).toContain('announceReady');
    expect(html).toContain('Content-Security-Policy');
  });

  it('escapes HTML in the hint so renderer-provided copy cannot inject markup', () => {
    const html = buildRegionCaptureOverlayHtml('<img src=x onerror=alert(1)> & "quotes"');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });
});
