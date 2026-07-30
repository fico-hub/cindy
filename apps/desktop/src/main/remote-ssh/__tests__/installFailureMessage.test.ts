/**
 * installFailureMessage.test.ts — silent-install 失败文案与「未安装」区分(issue #1023)。
 * 钉死:失败主体标明是 Cindy 专用远程运行时;log 尾行保留;远端存在系统级同名
 * CLI 时明确说明它不受影响也不被使用 —— 修复前用户看到「远端没有安装 Codex」,
 * 而他们 PATH 里的 codex 明明可用,排查方向被带偏。
 */

import { describe, expect, it } from 'vitest';

import { composeInstallFailureMessage } from '../install-failure-message.js';

describe('composeInstallFailureMessage', () => {
  it('失败主体标明 Cindy 专用运行时,根因与 log 尾行保留', () => {
    const msg = composeInstallFailureMessage({
      agentKind: 'codex',
      baseMsg: 'install.sh exit=4',
      logTail: ['[install.sh] fatal: not a git repository (or any of the parent directories): .git'],
      systemBinPath: null,
    });
    expect(msg).toContain('Cindy 专用远程运行时');
    expect(msg).toContain('install.sh exit=4');
    expect(msg).toContain('fatal: not a git repository');
    // 未探测到系统 CLI 时不提及,避免无关信息。
    expect(msg).not.toContain('系统安装');
  });

  it('远端存在系统级 CLI ⇒ 明确说明不受影响、并非未安装', () => {
    const msg = composeInstallFailureMessage({
      agentKind: 'codex',
      baseMsg: 'install.sh exit=4',
      logTail: [],
      systemBinPath: '/home/ro_dev/node-v22/bin/codex',
    });
    expect(msg).toContain('/home/ro_dev/node-v22/bin/codex');
    expect(msg).toContain('并非远端未安装 codex');
    expect(msg).toContain('不受影响');
  });

  it('claude-code 用 claude 作为二进制名', () => {
    const msg = composeInstallFailureMessage({
      agentKind: 'claude-code',
      baseMsg: 'npm install failed',
      logTail: [],
      systemBinPath: '/usr/local/bin/claude',
    });
    expect(msg).toContain('claude(/usr/local/bin/claude)');
  });
});
