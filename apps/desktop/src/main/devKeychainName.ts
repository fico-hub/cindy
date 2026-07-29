/**
 * devKeychainName — 隔离 dev 实例的 safeStorage 钥匙串条目隔离(#871 候选 B 的收窄落地)。
 *
 * macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
 * (service = `<app.name> Safe Storage`),而 `app.name` 默认取 productName('Cindy'),
 * 三种身份(packaged cn / packaged global / 未打包 dev)共用同一条目:每种签名身份
 * 首次使用都会触发系统钥匙串授权弹窗,dev 的 stock Electron cdhash 也会进入正式
 * 条目的 ACL(#871)。
 *
 * 收窄语义 —— 只隔离显式声明隔离意图(`--isolated` / `XDT_ISOLATED=1`)的 dev 沙箱:
 *  - 身份由 profile 根的标记文件承载,首启用「临时文件写完整内容 + hard link 独占
 *    落位」原子认领(可见即完整);此后每次启动按标记粘住,不看目录内容。
 *  - 标记读取三态:present / absent(仅 ENOENT)/ unreadable(其它 IO 错)。
 *    **不确定即拒绝启动**(review 反馈 P1 第七轮):标记暂不可读、内容为空或不可
 *    识别时,沙箱可能已有按 CindyDev 主密钥加密的存量密文,静默回退默认身份会用
 *    错钥匙覆盖它们——dev-only 场景响亮失败并给出处置指引,优于任何猜测。
 *  - 无标记(确证 ENOENT)且 profile 已有真实数据(排除标记自身产物)→ 复查标记
 *    后判旧沙箱,永久保持默认条目名(存量密文绑定 `Cindy Safe Storage`)。
 *  - 无标记且 profile 为空 = 全新沙箱 → 原子认领;输掉竞态以胜者完整标记为准;
 *    认领写失败 → 保持默认名(此时 profile 仍为空、我们尚未写入任何密文,后续
 *    自然沉淀为「旧沙箱」形态,跨重启自洽)。
 *  - 仅设 `XDT_USER_DATA_DIR`(目录覆写,无隔离意图)、共享 userData 的 dev、
 *    packaged cn/global 一律不改名;packaged 改名属存量凭证迁移(#871 候选 A)。
 *
 * 调用方(main 入口)必须**先显式 pin 住 userData** 再 `app.setName()`,并在收到
 * abort 决策时终止启动。
 */

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

/** 沙箱 profile 内的钥匙串身份标记文件名(userData 根下,纯文本存条目身份名)。 */
export const KEYCHAIN_IDENTITY_MARKER_FILE = 'keychain-identity';

/** 该目录项是否属于身份标记机制自己的产物(最终标记 或 `<marker>.<pid>.tmp` 半成品)。 */
export function isKeychainIdentityMarkerArtifact(entryName: string): boolean {
  if (entryName === KEYCHAIN_IDENTITY_MARKER_FILE) return true;
  return (
    entryName.startsWith(`${KEYCHAIN_IDENTITY_MARKER_FILE}.`) && entryName.endsWith('.tmp')
  );
}

/** 标记读取三态:absent 仅代表确证的 ENOENT;其它 IO 错一律 unreadable。 */
export type KeychainMarkerRead =
  | { kind: 'present'; value: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/** 标记文件与 profile 的 IO 面(注入以便单测竞态时序)。 */
export interface KeychainIdentityIo {
  readMarker(): KeychainMarkerRead;
  /**
   * 原子独占发布**完整**标记(临时文件写完 + hard link 独占落位):标记一旦可见
   * 内容即完整,不得出现可被对手读到的零长度文件。已存在 → 'exists',其它失败 → 'error'。
   */
  claimMarker(name: string): 'claimed' | 'exists' | 'error';
  /**
   * profile 目录是否已有**真实数据**(读失败按 true,方向安全)。实现必须用
   * isKeychainIdentityMarkerArtifact 排除标记文件与其 .tmp 半成品。
   */
  profileHasData(): boolean;
}

export type DevKeychainDecision =
  | { kind: 'rename'; appName: string }
  | { kind: 'keep-default' }
  /** 身份不确定(标记不可读/内容不可识别):必须终止启动,不得用任一身份写入。 */
  | { kind: 'abort'; reason: string };

function interpretMarker(read: KeychainMarkerRead, devName: string): DevKeychainDecision | null {
  if (read.kind === 'unreadable') {
    return { kind: 'abort', reason: '身份标记读取失败(非 ENOENT)' };
  }
  if (read.kind === 'present') {
    if (read.value === devName) return { kind: 'rename', appName: devName };
    // 空串或不可识别的值:身份不确定。可能是损坏的 CindyDev 标记——静默回退默认
    // 身份会用错钥匙覆盖既有密文(review 反馈 P1 第七轮),拒绝启动。
    return { kind: 'abort', reason: `身份标记内容不可识别: ${JSON.stringify(read.value)}` };
  }
  return null; // absent → 由调用侧继续判定。
}

export function resolveDevKeychainDecision(input: {
  isPackaged: boolean;
  /** devCliFlags 解析结果:仅 --isolated / XDT_ISOLATED 表达的显式隔离意图。 */
  isolated: boolean;
  io: KeychainIdentityIo;
}): DevKeychainDecision {
  if (input.isPackaged || !input.isolated) return { kind: 'keep-default' };
  const devName = BRAND_IDENTITY.executableNameByRegion.dev;

  const first = interpretMarker(input.io.readMarker(), devName);
  if (first !== null) return first;

  if (input.io.profileHasData()) {
    // 无标记但有数据:复查标记,关掉「对手在首读后发布标记+数据」的并发窗口;
    // 复查确证 absent 才是真旧沙箱。
    const recheck = interpretMarker(input.io.readMarker(), devName);
    return recheck ?? { kind: 'keep-default' };
  }

  // 全新沙箱:原子认领。
  const claim = input.io.claimMarker(devName);
  if (claim === 'claimed') return { kind: 'rename', appName: devName };
  if (claim === 'exists') {
    const winner = interpretMarker(input.io.readMarker(), devName);
    // EEXIST 后复读确证 absent(对手发布后又消失)同样属身份不确定,拒绝启动。
    return winner ?? { kind: 'abort', reason: '认领竞态后身份标记消失' };
  }
  // 认领写失败:profile 仍为空、尚未写过任何密文,保持默认名跨重启自洽。
  return { kind: 'keep-default' };
}
