/**
 * send_to_session create 的 working_dir 覆盖校验(#811):绝对路径 + 已存在目录,
 * 其余形态给出可行动错误文案。
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
  it('已存在目录(绝对路径)→ null', async () => {
    expect(await validateHandoffWorkingDir(dir)).toBeNull();
  });

  it('相对路径 → 报绝对路径要求', async () => {
    expect(await validateHandoffWorkingDir('relative/path')).toContain('绝对路径');
  });

  it('不存在的路径 → 报不存在', async () => {
    expect(await validateHandoffWorkingDir(path.join(dir, 'nope'))).toContain('不存在');
  });

  it('指向文件 → 报不是目录', async () => {
    expect(await validateHandoffWorkingDir(file)).toContain('不是目录');
  });

  it('空串 → 报不能为空', async () => {
    expect(await validateHandoffWorkingDir('')).toContain('不能为空');
  });
});
