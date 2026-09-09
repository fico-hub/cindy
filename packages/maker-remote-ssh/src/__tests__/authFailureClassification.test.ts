/**
 * isAuthFailure ↔ authFailureHint 的 invariant 回归。
 *
 * 背景（2026-07 cindy_ssh PR review 发现）：connect() 失败时会把 ssh2 原始
 * auth 错误改写成 authFailureHint 的友好文案再 reject / 存进 lastError，而
 * 后续所有"是否认证失败"的判定（RemoteHost 自身的 reconnect 跳过、desktop
 * ensureRemoteHostReady 的 IPC 错误码分类、cindy_ssh 工具错误码）都跑在改写
 * 后的字符串上。若 isAuthFailure 不识别自家 hint 文案，确定性的认证失败会
 * 被降级成"可重试的连接失败"，引发无意义重连/重试。
 *
 * 因此硬性 invariant：authFailureHint 的每一种输出都必须让 isAuthFailure
 * 返回 true。改 hint 措辞时本测试会红，提醒同步 isAuthFailure 的关键词表。
 */

import { describe, it, expect } from 'vitest';

import { isAuthFailure, authFailureHint, describeIdentityPath } from '../RemoteHost.js';
import type { HostConfig } from '../types.js';

function cfg(partial: Partial<HostConfig>): HostConfig {
  return {
    id: 'web-1',
    hostname: '10.0.0.5',
    port: 22,
    user: 'deploy',
    authMethod: 'agent',
    source: 'manual',
    managedByCindy: false,
    ...partial,
  };
}

describe('isAuthFailure recognizes every authFailureHint variant', () => {
  it('agent mode hint', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent' })))).toBe(true);
  });

  it('agent mode hint with non-default port', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent', port: 2222 })))).toBe(true);
  });

  it('pinned agent hint tells the user to load the matching key', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'agent',
      sshAuthentication: {
        identitiesOnly: true,
        configuredIdentityFiles: ['/home/u/.ssh/id_ed25519'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
        allowedAgentFingerprints: ['SHA256:test'],
      },
    }));
    expect(hint).toContain('ssh-add');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('key mode hint (with and without identityFile)', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'key',
      identityFile: '/home/u/.ssh/custom-private.key',
    }));
    expect(isAuthFailure(hint)).toBe(true);
    expect(hint).toContain('<public-key-file>');
    expect(hint).not.toContain('/home/u/.ssh');
    expect(hint).not.toContain('custom-private.key.pub');
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'key' })))).toBe(true);
  });

  it('fallback hint', () => {
    // authMethod 越界时走兜底文案("Authentication failed connecting as ...")。
    expect(
      isAuthFailure(authFailureHint(cfg({ authMethod: 'password' as HostConfig['authMethod'] }))),
    ).toBe(true);
  });
});

describe('authFailureHint names the identity set and keeps the real reason (#4201)', () => {
  const pinnedCfg = cfg({
    authMethod: 'agent',
    sshAuthentication: {
      identitiesOnly: true,
      configuredIdentityFiles: ['/home/u/.ssh/id_ed25519_github'],
      identityFileDirectiveSeen: true,
      identityFileNoneSeen: false,
      allowedAgentFingerprints: ['SHA256:test'],
    },
  });

  it('pinned agent: says the remote rejected the configured identity set, names the IdentityFile, and does not assert the key is missing from the agent', () => {
    const hint = authFailureHint(pinnedCfg, { homeDir: '/home/u' });
    expect(hint).toContain('IdentityFile: ~/.ssh/id_ed25519_github');
    expect(hint).toContain('was rejected by the remote');
    expect(hint).not.toContain('has no key');
    // 绝对路径不进用户可见文案(主目录缩写),也不猜 .pub 文件名。
    expect(hint).not.toContain('/home/u/.ssh');
    expect(hint).not.toContain('.pub');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('pinned agent: explicit Cindy identity marker is listed first, de-duplicated against ssh_config entries', () => {
    const hint = authFailureHint(
      cfg({
        ...pinnedCfg,
        identityFile: '/home/u/.ssh/id_ed25519_github',
        sshAuthentication: {
          ...pinnedCfg.sshAuthentication!,
          configuredIdentityFiles: ['/home/u/.ssh/id_ed25519_github', '/home/u/.ssh/id_rsa'],
        },
      }),
      { homeDir: '/home/u' },
    );
    expect(hint).toContain('IdentityFile: ~/.ssh/id_ed25519_github, ~/.ssh/id_rsa');
    expect(hint.split('id_ed25519_github').length - 1).toBe(1);
  });

  it('appends the underlying ssh2 reason once, and not when the text already says it', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      cause: 'All configured authentication methods failed',
    });
    expect(hint).toContain('(ssh: All configured authentication methods failed)');
    expect(hint.split('All configured authentication methods failed').length - 1).toBe(1);
    expect(isAuthFailure(hint)).toBe(true);

    const plain = authFailureHint(cfg({ authMethod: 'agent' }), { cause: '  ' });
    expect(plain).not.toContain('(ssh:');
    const fallback = authFailureHint(
      cfg({ authMethod: 'password' as HostConfig['authMethod'] }),
      { cause: 'Authentication failed.' },
    );
    expect(fallback).toContain('(ssh: Authentication failed.)');
    expect(isAuthFailure(fallback)).toBe(true);
  });

  it('key mode names the identity by basename only when it is outside the home directory', () => {
    const hint = authFailureHint(
      cfg({ authMethod: 'key', identityFile: '/srv/keys/deploy.key' }),
      { homeDir: '/home/u', cause: 'All configured authentication methods failed' },
    );
    expect(hint).toContain('The configured identity file (deploy.key) was rejected by the remote');
    expect(hint).not.toContain('/srv/keys');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('describeIdentityPath abbreviates home, keeps ~ forms, and otherwise falls back to the basename', () => {
    expect(describeIdentityPath('/home/u/.ssh/id_ed25519', '/home/u')).toBe('~/.ssh/id_ed25519');
    expect(describeIdentityPath('~/.ssh/id_ed25519', '/home/u')).toBe('~/.ssh/id_ed25519');
    expect(describeIdentityPath('/srv/keys/deploy.key', '/home/u')).toBe('deploy.key');
    expect(describeIdentityPath('/home/u2/.ssh/id_rsa', '/home/u')).toBe('id_rsa');
    expect(describeIdentityPath('   ', '/home/u')).toBe('');
  });
});

describe('isAuthFailure still recognizes raw ssh2 auth errors', () => {
  it.each([
    'All configured authentication methods failed',
    'Authentication failed.',
    'auth failed',
    'Permission denied (publickey)',
    'No matching authentication scheme',
  ])('%s', (msg) => {
    expect(isAuthFailure(msg)).toBe(true);
  });

  it('does not misclassify plain connection errors', () => {
    expect(isAuthFailure('connect ETIMEDOUT 10.0.0.5:22')).toBe(false);
    expect(isAuthFailure('connection closed before ready')).toBe(false);
  });
});
