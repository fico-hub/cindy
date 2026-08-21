import { createHash } from 'node:crypto';

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

  // CSP 用 sha256 hash 白名单固定的内联样式/脚本, 不引入 'unsafe-inline'
  // (仓库安全约束, review P1): 任一动态值转义遗漏也无法注入可执行脚本。
  it('uses sha256-hash CSP without unsafe-inline', () => {
    const html = buildRegionCaptureOverlayHtml('hint');
    expect(html).not.toContain('unsafe-inline');
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(html).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    // hash 与实际内联块内容一致: 同一常量既进 CSP 哈希也进标签体, 提取
    // 标签体重新计算应与 CSP 声明完全相同。
    for (const [tag, directive] of [
      ['style', 'style-src'],
      ['script', 'script-src'],
    ] as const) {
      const body = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(html).toContain(`${directive} 'sha256-${hash}'`);
    }
  });

  it('escapes HTML in the hint so renderer-provided copy cannot inject markup', () => {
    const html = buildRegionCaptureOverlayHtml('<img src=x onerror=alert(1)> & "quotes"');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });
});
