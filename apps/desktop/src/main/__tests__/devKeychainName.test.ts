/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:
 *  - 身份由 profile 标记文件粘住:有标记按标记,不看目录内容(否则第二次启动翻转)。
 *  - 无标记且有数据 → 复查标记后才判旧沙箱(并发首启对手可能在首读后写入标记+数据)。
 *  - 无标记且为空 → O_EXCL 原子认领;输掉竞态以胜者标记为准;写失败不改名。
 *  - packaged / 非隔离一律默认名。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  isKeychainIdentityMarkerArtifact,
  resolveDevKeychainAppName,
  type KeychainIdentityIo,
} from '../devKeychainName.js';

function io(overrides: Partial<KeychainIdentityIo>): KeychainIdentityIo {
  return {
    readMarker: () => null,
    claimMarker: () => 'claimed',
    profileHasData: () => false,
    ...overrides,
  };
}

const base = { isPackaged: false, isolated: true };

describe('resolveDevKeychainAppName', () => {
  it('有标记 = CindyDev → 跨重启粘住,不看目录内容', () => {
    expect(
      resolveDevKeychainAppName({
        ...base,
        io: io({ readMarker: () => 'CindyDev', profileHasData: () => true }),
      }),
    ).toBe('CindyDev');
  });

  it('未知标记值 → 保守不改名', () => {
    expect(
      resolveDevKeychainAppName({ ...base, io: io({ readMarker: () => 'SomethingElse' }) }),
    ).toBeNull();
  });

  it('全新沙箱 → 原子认领成功后改名', () => {
    const claim = vi.fn<KeychainIdentityIo['claimMarker']>(() => 'claimed');
    expect(resolveDevKeychainAppName({ ...base, io: io({ claimMarker: claim }) })).toBe('CindyDev');
    expect(claim).toHaveBeenCalledWith('CindyDev');
  });

  it('全新沙箱认领输掉竞态(EEXIST)→ 以胜者写入的标记为准', () => {
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(null) // 首读:无标记
      .mockReturnValueOnce('CindyDev'); // 认领失败后复读:胜者已写
    expect(
      resolveDevKeychainAppName({
        ...base,
        io: io({ readMarker: reads, claimMarker: () => 'exists' }),
      }),
    ).toBe('CindyDev');
  });

  it('认领写失败 → 不改名(防「改了名但标记没落盘」的翻转窗口)', () => {
    expect(
      resolveDevKeychainAppName({ ...base, io: io({ claimMarker: () => 'error' }) }),
    ).toBeNull();
  });

  it('输掉竞态但复读不到有效标记(如历史空标记)→ 不改名,退默认名不分叉', () => {
    // claimMarker 契约要求标记可见即完整(临时文件 + hard link 发布);万一 profile
    // 里存在历史空标记,readMarker 视同无标记 → 保守退默认名,与「有数据判旧沙箱」
    // 方向一致,不与任何对手分叉。
    expect(
      resolveDevKeychainAppName({
        ...base,
        io: io({ claimMarker: () => 'exists', readMarker: () => null }),
      }),
    ).toBeNull();
  });

  it('无标记且有数据:复查到对手写入的标记 → 与对手一致,不分叉(并发首启)', () => {
    // review 反馈 P1 第四轮:A 首读标记为空后,B 写入标记+数据;A 看到目录非空,
    // 必须复查标记而不是直接判旧沙箱。
    const reads = vi
      .fn<KeychainIdentityIo['readMarker']>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce('CindyDev');
    expect(
      resolveDevKeychainAppName({
        ...base,
        io: io({ readMarker: reads, profileHasData: () => true }),
      }),
    ).toBe('CindyDev');
  });

  it('无标记且有数据,复查仍无标记 = 真旧沙箱 → 永久默认名', () => {
    expect(
      resolveDevKeychainAppName({ ...base, io: io({ profileHasData: () => true }) }),
    ).toBeNull();
  });

  it('非隔离 dev 与 packaged → 一律不改名,不做任何 IO', () => {
    const reads = vi.fn<KeychainIdentityIo['readMarker']>(() => 'CindyDev');
    expect(
      resolveDevKeychainAppName({ isPackaged: false, isolated: false, io: io({ readMarker: reads }) }),
    ).toBeNull();
    expect(
      resolveDevKeychainAppName({ isPackaged: true, isolated: true, io: io({ readMarker: reads }) }),
    ).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('isKeychainIdentityMarkerArtifact', () => {
  it('标记文件与 .tmp 半成品是机制自身产物,不构成「旧沙箱证据」', () => {
    // 并发首启时对手的 tmp 半成品先于 hard link 落位可见;profileHasData 若把它当
    // 真实数据,输家会误判旧沙箱、与胜者身份分叉(review 反馈 P1 第六轮)。
    expect(isKeychainIdentityMarkerArtifact('keychain-identity')).toBe(true);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity.12345.tmp')).toBe(true);
    // 真实数据不得被误排除。
    expect(isKeychainIdentityMarkerArtifact('cindy-user1.db')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('safe-storage')).toBe(false);
    expect(isKeychainIdentityMarkerArtifact('keychain-identity-notes.txt')).toBe(false);
  });
});
