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
  it('显式隔离 + 全新沙箱(目录不存在或 wrapper 预创建的空目录)→ 独立条目名 CindyDev', () => {
    expect(
      resolveDevKeychainAppName({ isPackaged: false, isolated: true, userDataProfileHasData: false }),
    ).toBe('CindyDev');
  });

  it('显式隔离但沙箱已有数据(旧版本用过)→ 不改名(存量密文绑定旧条目主密钥)', () => {
    // 既有隔离沙箱可能带着 'Cindy Safe Storage' 加密的 .enc(登录态、手填 key、
    // OAuth/IM 凭证);换名不仅读不出,重存还会覆盖唯一可恢复的旧密文(review 反馈 P1)。
    // 判据是「有内容」而非「目录存在」:restart-desktop-remote.mjs 启动前会预创建
    // **空**目录,只看存在会把标准隔离启动路径全判成旧沙箱(review 反馈 P1)。
    expect(
      resolveDevKeychainAppName({ isPackaged: false, isolated: true, userDataProfileHasData: true }),
    ).toBeNull();
  });

  it('共享 userData / 仅目录覆写(无隔离意图)的 dev → 不改名(密文绑定原条目主密钥)', () => {
    // 裸设 XDT_USER_DATA_DIR 时 devCliFlags 的 isolated 保持 false(目录覆写不表达
    // 隔离意图,可能指向共享中的既有 profile)——不得改名(review 反馈 P1)。
    expect(
      resolveDevKeychainAppName({ isPackaged: false, isolated: false, userDataProfileHasData: false }),
    ).toBeNull();
  });

  it('packaged 构建 → 一律不改名(存量凭证迁移须单独设计,#871 候选 A)', () => {
    expect(
      resolveDevKeychainAppName({ isPackaged: true, isolated: false, userDataProfileHasData: false }),
    ).toBeNull();
    expect(
      resolveDevKeychainAppName({ isPackaged: true, isolated: true, userDataProfileHasData: false }),
    ).toBeNull();
  });
});
