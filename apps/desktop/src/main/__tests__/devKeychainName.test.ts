/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:只有「未打包 + 独立 userData」才换名;packaged 构建与共享 userData
 * 的 dev 一律保持默认名——共享 profile 的存量密文必须继续用同一把主密钥,换名会
 * 双向串坏(dev 读不了旧的,正式版读不了 dev 新写的)。
 */

import { describe, expect, it } from 'vitest';

import { resolveDevKeychainAppName } from '../devKeychainName.js';

describe('resolveDevKeychainAppName', () => {
  it('隔离 dev(独立 userData)→ 独立条目名 CindyDev', () => {
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        userDataDirOverride: '/tmp/cindy-dev-sandbox',
      }),
    ).toBe('CindyDev');
  });

  it('共享 userData 的 dev → 不改名(共享 profile 密文绑定原条目主密钥)', () => {
    expect(resolveDevKeychainAppName({ isPackaged: false, userDataDirOverride: null })).toBeNull();
  });

  it('packaged 构建 → 一律不改名(存量凭证迁移须单独设计,#871 候选 A)', () => {
    expect(
      resolveDevKeychainAppName({ isPackaged: true, userDataDirOverride: null }),
    ).toBeNull();
    expect(
      resolveDevKeychainAppName({ isPackaged: true, userDataDirOverride: '/tmp/x' }),
    ).toBeNull();
  });
});
