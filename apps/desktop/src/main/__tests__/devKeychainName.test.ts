/**
 * devKeychainName — 隔离 dev 实例的钥匙串条目隔离语义(#871 候选 B 收窄)。
 *
 * 关键不变量:
 *  - 身份由 profile 标记文件粘住:标记 = CindyDev 时无论目录内容如何都保持 CindyDev
 *    (「目录为空」不能当持续判据——首启写数据后第二次启动会翻转身份、密文报废)。
 *  - 无标记且有数据 = 本改动前的旧沙箱,永久保持默认名(存量密文绑定旧条目主密钥)。
 *  - 无标记且为空 = 全新沙箱(含 wrapper 预创建的空目录)→ 选定 CindyDev。
 *  - packaged / 非隔离(共享 userData、裸 XDT_USER_DATA_DIR 目录覆写)一律默认名。
 */

import { describe, expect, it } from 'vitest';

import { resolveDevKeychainAppName } from '../devKeychainName.js';

describe('resolveDevKeychainAppName', () => {
  it('全新沙箱(无标记、目录不存在或 wrapper 预创建的空目录)→ 选定 CindyDev', () => {
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        isolated: true,
        markerIdentity: null,
        profileHasData: false,
      }),
    ).toBe('CindyDev');
  });

  it('已初始化沙箱(标记 = CindyDev)→ 跨重启粘住,不看目录内容', () => {
    // 首启写入数据后第二次启动目录必然非空——身份必须由标记而非目录内容决定
    // (review 反馈 P1:身份翻转会让首启写入的密文全部报废)。
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        isolated: true,
        markerIdentity: 'CindyDev',
        profileHasData: true,
      }),
    ).toBe('CindyDev');
  });

  it('旧沙箱(无标记但已有数据)→ 永久保持默认名(存量密文绑定旧条目主密钥)', () => {
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        isolated: true,
        markerIdentity: null,
        profileHasData: true,
      }),
    ).toBeNull();
  });

  it('未知标记值 → 保守不改名(误判方向安全)', () => {
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        isolated: true,
        markerIdentity: 'SomethingElse',
        profileHasData: false,
      }),
    ).toBeNull();
  });

  it('非隔离 dev(共享 userData / 裸目录覆写)与 packaged → 一律不改名', () => {
    expect(
      resolveDevKeychainAppName({
        isPackaged: false,
        isolated: false,
        markerIdentity: null,
        profileHasData: false,
      }),
    ).toBeNull();
    expect(
      resolveDevKeychainAppName({
        isPackaged: true,
        isolated: true,
        markerIdentity: 'CindyDev',
        profileHasData: false,
      }),
    ).toBeNull();
  });
});
