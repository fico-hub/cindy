/**
 * devKeychainMarkerIo 集成测试:mkdtemp 真实文件系统上验证原子认领协议
 * (review 反馈 P1:手写 crash-consistency / concurrency 协议必须有直接覆盖,
 * 防 O_EXCL 回退 / fsync 顺序 / 短写处理在后续编辑中无声回归)。
 * 决策纯逻辑(resolveDevKeychainDecision)的矩阵在 devKeychainName.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKeychainMarkerIo } from '../devKeychainMarkerIo';
import { KEYCHAIN_IDENTITY_MARKER_FILE } from '../devKeychainName';

let profileDir: string;
let markerPath: string;

const makeIo = (fsOverrides?: Parameters<typeof createKeychainMarkerIo>[0]['fsOverrides']) =>
  createKeychainMarkerIo({ markerPath, profileDir, fsOverrides });

/** 模拟不支持硬链接的文件系统(exFAT / 部分 SMB):link 报非 EEXIST 错。 */
const linkUnsupported: typeof fs.linkSync = () => {
  const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  throw err;
};

beforeEach(() => {
  profileDir = fs.mkdtempSync(join(tmpdir(), 'keychain-marker-io-'));
  markerPath = join(profileDir, KEYCHAIN_IDENTITY_MARKER_FILE);
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe('createKeychainMarkerIo', () => {
  it('hard-link 成功路径:认领落位完整标记,临时文件清理干净', () => {
    const io = makeIo();
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
    expect(io.readMarker()).toEqual({ kind: 'present', value: 'CindyDev\n' });
    // 临时文件(<marker>.<pid>-<uuid>.tmp)不残留
    expect(fs.readdirSync(profileDir)).toEqual([KEYCHAIN_IDENTITY_MARKER_FILE]);
  });

  it('认领竞态(link 路径):输家得 exists,胜者内容不被改写', () => {
    const winner = makeIo();
    const loser = makeIo();
    expect(winner.claimMarker('CindyDev')).toBe('claimed');
    expect(loser.claimMarker('Cindy')).toBe('exists');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('O_EXCL 回退路径:link 不支持时仍原子认领,竞态输家得 exists', () => {
    const io = makeIo({ linkSync: linkUnsupported });
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
    const loser = makeIo({ linkSync: linkUnsupported });
    expect(loser.claimMarker('Cindy')).toBe('exists');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('短写场景:writeSync 每次只写 1 字节,协议循环写满,标记仍完整', () => {
    const oneByteWrites = ((fd: number, data: NodeJS.ArrayBufferView, offset?: number | null, _length?: number | null, position?: number | null) =>
      fs.writeSync(fd, data, offset ?? 0, 1, position ?? null)) as typeof fs.writeSync;
    const io = makeIo({ writeSync: oneByteWrites });
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('短写零进展:按写失败收敛为 error,不发布任何标记', () => {
    const stuckWrites: typeof fs.writeSync = () => 0;
    const io = makeIo({ writeSync: stuckWrites });
    expect(io.claimMarker('CindyDev')).toBe('error');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(io.readMarker()).toEqual({ kind: 'absent' });
  });

  it('readMarker 防御:符号链接 / 超限内容 / 目录形态一律 unreadable,缺失为 absent', () => {
    const io = makeIo();
    expect(io.readMarker()).toEqual({ kind: 'absent' });
    // 符号链接(O_NOFOLLOW 拒绝)
    const realFile = join(profileDir, 'real.txt');
    fs.writeFileSync(realFile, 'CindyDev\n');
    fs.symlinkSync(realFile, markerPath);
    expect(io.readMarker()).toEqual({ kind: 'unreadable' });
    fs.unlinkSync(markerPath);
    // 超过 256B 上限的外来文件
    fs.writeFileSync(markerPath, `${'x'.repeat(300)}\n`);
    expect(io.readMarker()).toEqual({ kind: 'unreadable' });
    fs.unlinkSync(markerPath);
    // 目录占位(fstat 非普通文件)
    fs.mkdirSync(markerPath);
    expect(io.readMarker()).toEqual({ kind: 'unreadable' });
  });

  it('profileHasData:标记与 .tmp 半成品不算数据,真实文件算', () => {
    const io = makeIo();
    expect(io.profileHasData()).toBe(false);
    io.claimMarker('CindyDev');
    fs.writeFileSync(join(profileDir, `${KEYCHAIN_IDENTITY_MARKER_FILE}.123-abc.tmp`), 'CindyDev\n');
    expect(io.profileHasData()).toBe(false);
    fs.writeFileSync(join(profileDir, 'config.json'), '{}');
    expect(io.profileHasData()).toBe(true);
  });
});
