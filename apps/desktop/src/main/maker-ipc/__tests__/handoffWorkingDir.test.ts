/**
 * send_to_session create 的 working_dir 覆盖校验(#811):绝对路径 + 已存在目录,
 * 通过时返回规范化路径(trim + resolve),失败给出可行动错误文案。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { validateHandoffWorkingDir } from '../handoffWorkingDir.js';

const dir = mkdtempSync(path.join(tmpdir(), 'cindy-handoff-wd-'));
const file = path.join(dir, 'plain.txt');
writeFileSync(file, 'x');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('validateHandoffWorkingDir', () => {
  it('已存在目录(绝对路径)→ ok 且返回规范化路径', async () => {
    expect(await validateHandoffWorkingDir(dir)).toEqual({ ok: true, dir: path.resolve(dir) });
  });

  it('带前后空白的合法路径 → trim 后通过,返回规范化路径(review 反馈)', async () => {
    expect(await validateHandoffWorkingDir(`  ${dir}  `)).toEqual({
      ok: true,
      dir: path.resolve(dir),
    });
  });

  it('相对路径 → 报绝对路径要求', async () => {
    const r = await validateHandoffWorkingDir('relative/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('绝对路径');
  });

  it('不存在的路径 → 报不存在', async () => {
    const r = await validateHandoffWorkingDir(path.join(dir, 'nope'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不存在');
  });

  it('指向文件 → 报不是目录', async () => {
    const r = await validateHandoffWorkingDir(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('不是目录');
  });

  it('空串 / 纯空白 → 报不能为空', async () => {
    for (const input of ['', '   ']) {
      const r = await validateHandoffWorkingDir(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('不能为空');
    }
  });
});
