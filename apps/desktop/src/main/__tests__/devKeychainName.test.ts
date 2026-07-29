/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:只有「未打包 + 显式隔离意图(--isolated / XDT_ISOLATED)」才换名;
 * packaged 构建、共享 userData 的 dev、以及仅目录覆写(裸 XDT_USER_DATA_DIR,
 * 无隔离意图,可能指向共享中的既有 profile)一律保持默认名——共享 profile 的
 * 存量密文必须继续用同一把主密钥,换名会双向串坏(dev 读不了旧的,正式版读不了
 * dev 新写的)。
 */

import { describe, expect, it } from 'vitest';

import { resolveDevKeychainAppName } from '../devKeychainName.js';

describe('resolveDevKeychainAppName', () => {
  it('显式隔离 dev(--isolated / XDT_ISOLATED)→ 独立条目名 CindyDev', () => {
    expect(resolveDevKeychainAppName({ isPackaged: false, isolated: true })).toBe('CindyDev');
  });

  it('共享 userData / 仅目录覆写(无隔离意图)的 dev → 不改名(密文绑定原条目主密钥)', () => {
    // 裸设 XDT_USER_DATA_DIR 时 devCliFlags 的 isolated 保持 false(目录覆写不表达
    // 隔离意图,可能指向共享中的既有 profile)——不得改名(review 反馈 P1)。
    expect(resolveDevKeychainAppName({ isPackaged: false, isolated: false })).toBeNull();
  });

  it('packaged 构建 → 一律不改名(存量凭证迁移须单独设计,#871 候选 A)', () => {
    expect(resolveDevKeychainAppName({ isPackaged: true, isolated: false })).toBeNull();
    expect(resolveDevKeychainAppName({ isPackaged: true, isolated: true })).toBeNull();
  });
});
