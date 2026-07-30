/**
 * cardSegments.test.ts — 飞书长回复分段纯逻辑(issue #924)。
 * 钉死:超限文本按行分段且每段字节数不超预算;跨段代码块 fence 补平;
 * 单行超限按码点硬切不撕代理对;中间帧截尾保留尾部并补 fence。
 * 修复前超长回复在 finalize patch 被飞书 API 拒收,catch 只 log.warn ——
 * 卡片停在流式中间帧,整条回复静默丢失。
 */

import { describe, it, expect } from 'vitest';

import {
  FEISHU_CARD_TEXT_MAX_BYTES,
  capMarkdownTailBytes,
  splitMarkdownForCards,
} from '../feishu/cardSegments.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('splitMarkdownForCards', () => {
  it('未超限 ⇒ 原样单段(零行为变化)', () => {
    const text = '短回复\n\n带两行';
    expect(splitMarkdownForCards(text, 1000)).toEqual([text]);
  });

  it('超限按行分段,每段字节数 ≤ maxBytes,拼回不丢内容', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `第 ${i} 行:中文内容填充填充填充`);
    const text = lines.join('\n');
    const segs = splitMarkdownForCards(text, 800);
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) expect(bytes(seg)).toBeLessThanOrEqual(800);
    // 无 fence 场景分段是纯切分:拼回逐字等于原文。
    expect(segs.join('\n')).toBe(text);
  });

  it('跨段代码块:段尾补 ``` 关闭,下一段开头重开,每段独立渲染成立', () => {
    const code = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}; // 填充填充填充`);
    const text = ['前言', '```ts', ...code, '```', '后记'].join('\n');
    const segs = splitMarkdownForCards(text, 900);
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) {
      // 每段的 fence 标记行数必须为偶数(代码块自洽)。
      const fences = seg.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
      expect(fences % 2, seg.slice(0, 40)).toBe(0);
      expect(bytes(seg)).toBeLessThanOrEqual(900);
    }
  });

  it('单行超限按码点硬切:不撕多字节字符,拼回等于原行', () => {
    const line = '汉'.repeat(2000); // 6000 bytes
    const segs = splitMarkdownForCards(line, 700);
    expect(segs.length).toBeGreaterThan(1);
    for (const seg of segs) expect(bytes(seg)).toBeLessThanOrEqual(700);
    expect(segs.join('')).toBe(line);
    // 代理对(emoji)不被撕开:每段都是合法 UTF-8 往返。
    const emoji = '🎉'.repeat(1000);
    for (const seg of splitMarkdownForCards(emoji, 257)) {
      expect(Buffer.from(seg, 'utf8').toString('utf8')).toBe(seg);
    }
  });

  it('默认预算与飞书卡片上限匹配(常量防漂移)', () => {
    expect(FEISHU_CARD_TEXT_MAX_BYTES).toBeLessThan(30_000);
    expect(FEISHU_CARD_TEXT_MAX_BYTES).toBeGreaterThanOrEqual(20_000);
  });
});

describe('capMarkdownTailBytes', () => {
  it('未超限 ⇒ 原样', () => {
    expect(capMarkdownTailBytes('hello', 100, 'N:')).toBe('hello');
  });

  it('超限 ⇒ notice + 尾部,总字节不超上限,尾部内容来自原文结尾', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `行${i}内容内容内容`);
    const text = lines.join('\n');
    const capped = capMarkdownTailBytes(text, 600, '…(省略)\n');
    expect(bytes(capped)).toBeLessThanOrEqual(600);
    expect(capped.startsWith('…(省略)\n')).toBe(true);
    expect(capped.endsWith('行99内容内容内容')).toBe(true);
  });

  it('被丢弃头部含未关闭 fence ⇒ 尾部前补开 ```(尾部正处于代码块内)', () => {
    const code = Array.from({ length: 80 }, (_, i) => `line ${i} padding padding padding`);
    const text = ['```', ...code].join('\n'); // 整个尾部都在代码块内
    const capped = capMarkdownTailBytes(text, 500, 'N:\n');
    expect(capped.startsWith('N:\n```\n')).toBe(true);
  });

  it('单行超预算的极端情况按码点截尾,不撕多字节字符', () => {
    const text = '汉'.repeat(1000);
    const capped = capMarkdownTailBytes(text, 300, 'N:');
    expect(bytes(capped)).toBeLessThanOrEqual(300);
    expect(capped.startsWith('N:')).toBe(true);
    expect(Buffer.from(capped, 'utf8').toString('utf8')).toBe(capped);
  });
});
