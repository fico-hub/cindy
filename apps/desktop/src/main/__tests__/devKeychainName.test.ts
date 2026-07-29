/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:
 *  - 有标记按标记粘住;标记不可读/内容不可识别 = 身份不确定 → abort(静默回退
 *    默认身份会用错钥匙覆盖既有密文)。absent 仅代表确证 ENOENT。
 *  - 无标记且有真实数据(排除标记自身产物)→ 复查标记后判旧沙箱。
 *  - 无标记且为空 → 原子认领;输掉竞态以胜者完整标记为准;认领写失败(非 EEXIST)
 *    同样 abort——并发对手可能恰好认领成功,keep-default 会让同一 profile 双身份。
 *  - packaged / 非隔离一律默认名。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  isKeychainIdentityMarkerArtifact,
  resolveDevKeychainDecision,
  type KeychainIdentityIo,
  type KeychainMarkerRead,
} from '../devKeychainName.js';

const ABSENT: KeychainMarkerRead = { kind: 'absent' };
const DEV: KeychainMarkerRead = { kind: 'present', value: 'CindyDev' };

function io(overrides: Partial<KeychainIdentityIo>): KeychainIdentityIo {
  return {
    readMarker: () => ABSENT,
    claimMarker: () => 'claimed',
    profileHasData: () => false,
    flushProfileDir: () => true,
    ...overrides,
  };
}

const base = { isPackaged: false, isolated: true };

describe('resolveDevKeychainDecision', () => {
  it('有标记 = CindyDev → 跨重启粘住,不看目录内容', () => {
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => DEV, profileHasData: () => true }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('标记不可读(非 ENOENT)→ abort,不得静默回退默认身份(review 反馈 P1 第七轮)', () => {
    // 沙箱可能已有按 CindyDev 主密钥加密的密文;暂时读不出标记时用默认身份写入
    // 会用错钥匙覆盖它们。
    const d = resolveDevKeychainDecision({
      ...base,
      io: io({ readMarker: () => ({ kind: 'unreadable' }) }),
    });
    expect(d.kind).toBe('abort');
  });

  it('标记内容为空或不可识别 → abort(身份不确定)', () => {
    for (const value of ['', 'SomethingElse']) {
      const d = resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: () => ({ kind: 'present', value }) }),
      });
      expect(d.kind, JSON.stringify(value)).toBe('abort');
    }
  });

  it('全新沙箱 → 原子认领成功后改名', () => {
    const claim = vi.fn<KeychainIdentityIo['claimMarker']>(() => 'claimed');
    expect(resolveDevKeychainDecision({ ...base, io: io({ claimMarker: claim }) })).toEqual({
      kind: 'rename',
      appName: 'CindyDev',
    });
    expect(claim).toHaveBeenCalledWith('CindyDev');
  });

  it('认领输掉竞态(EEXIST)→ 以胜者完整标记为准', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('认领竞态后标记消失/不可读 → abort(身份不确定)', () => {
    for (const second of [ABSENT, { kind: 'unreadable' } as const]) {
      const reads = vi
        .fn<KeychainIdentityIo['readMarker']>()
        .mockReturnValueOnce(ABSENT)
        .mockReturnValueOnce(second);
      const d = resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      });
      expect(d.kind, second.kind).toBe('abort');
    }
  });

  it('认领写失败(非 EEXIST)→ abort(并发对手可能已认领成功,keep-default 会双身份)', () => {
    const d = resolveDevKeychainDecision({ ...base, io: io({ claimMarker: () => 'error' }) });
    expect(d.kind).toBe('abort');
  });

  it('无标记且有数据:复查到对手标记 → 与对手一致(并发首启不分叉)', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({ readMarker: reads, profileHasData: () => true }),
      }),
    ).toEqual({ kind: 'rename', appName: 'CindyDev' });
  });

  it('无标记且有数据,复查确证 absent = 真旧沙箱 → 永久默认名', () => {
    expect(
      resolveDevKeychainDecision({ ...base, io: io({ profileHasData: () => true }) }),
    ).toEqual({ kind: 'keep-default' });
  });

  it('非隔离 dev 与 packaged → 一律默认名,不做任何 IO', () => {
    const reads = vi.fn<KeychainIdentityIo['readMarker']>(() => DEV);
    expect(
      resolveDevKeychainDecision({ isPackaged: false, isolated: false, io: io({ readMarker: reads }) }),
    ).toEqual({ kind: 'keep-default' });
    expect(
      resolveDevKeychainDecision({ isPackaged: true, isolated: true, io: io({ readMarker: reads }) }),
    ).toEqual({ kind: 'keep-default' });
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('接受观察到的标记前必须持久化确认(review 反馈 P1 第十三轮)', () => {
  it('初读命中标记但 flush 失败 → abort,不得以未持久化的身份写入', () => {
    const d = resolveDevKeychainDecision({
      ...base,
      io: io({ readMarker: () => DEV, flushProfileDir: () => false }),
    });
    expect(d.kind).toBe('abort');
  });

  it('有数据复查命中 / 认领竞态读到胜者标记,flush 失败同样 abort', () => {
    const recheckReads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({
          readMarker: recheckReads,
          profileHasData: () => true,
          flushProfileDir: () => false,
        }),
      }).kind,
    ).toBe('abort');
    const raceReads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(ABSENT)
      .mockReturnValueOnce(DEV);
    expect(
      resolveDevKeychainDecision({
        ...base,
        io: io({
          readMarker: raceReads,
          claimMarker: () => 'exists',
          flushProfileDir: () => false,
        }),
      }).kind,
    ).toBe('abort');
  });
});

describe('isKeychainIdentityMarkerArtifact', () => {
  it('标记文件与 .tmp 半成品是机制自身产物,不构成「旧沙箱证据」', () => {
    expect(isKeychainIdentityMarkerArtifact('keychain-identity')).toBe(true);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity.12345.tmp')).toBe(true);
    expect(isKeychainIdentityMarkerArtifact('cindy-user1.db')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('safe-storage')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity-notes.txt')).toBe(false);
  });
});
