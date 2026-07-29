/**
 * devKeychainName — 隔离 dev 实例的 safeStorage 钥匙串条目隔离(#871 候选 B 的收窄落地)。
 *
 * macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
 * (service = `<app.name> Safe Storage`),而 `app.name` 默认取 productName('Cindy'),
 * 三种身份(packaged cn / packaged global / 未打包 dev)共用同一条目:每种签名身份
 * 首次使用都会触发系统钥匙串授权弹窗,dev 的 stock Electron cdhash 也会进入正式
 * 条目的 ACL(#871)。
 *
 * 收窄语义 —— 只隔离「显式声明隔离意图(`--isolated` / `XDT_ISOLATED=1`)**且目录为
 * 纪元派生路径**(<userData>-dev2[-<名字>],由 devCliFlags.isolatedDirIsEpochDerived
 * 判定;调用方把两者的合取作为本函数的 isolated 入参)」的 dev 沙箱——显式指向其它
 * 目录的隔离启动不标记,防同一目录被「--isolated + 覆写」与「裸覆写 / 旧 checkout」
 * 等受支持启动形态以两种钥匙串身份轮流打开(review 反馈 P1 第十二轮):
 *  - 身份由 profile 根的标记文件承载,首启用「临时文件写完整内容 + hard link 独占
 *    落位」原子认领(可见即完整);此后每次启动按标记粘住,不看目录内容。
 *  - 标记读取三态:present / absent(仅 ENOENT)/ unreadable(其它 IO 错)。
 *    **不确定即拒绝启动**(review 反馈 P1 第七轮):标记暂不可读、内容为空或不可
 *    识别时,沙箱可能已有按 CindyDev 主密钥加密的存量密文,静默回退默认身份会用
 *    错钥匙覆盖它们——dev-only 场景响亮失败并给出处置指引,优于任何猜测。
 *  - 无标记(确证 ENOENT)且 profile 已有真实数据(排除标记自身产物)→ 复查标记
 *    后判旧沙箱,永久保持默认条目名(存量密文绑定 `Cindy Safe Storage`)。
 *  - 无标记且 profile 为空 = 全新沙箱 → 原子认领;输掉竞态以胜者完整标记为准;
 *    认领写失败(非 EEXIST 的瞬时错)同样 abort——「保持默认名」只在单进程下自洽,
 *    并发场景另一进程可能恰好认领成功,同一 profile 会跑在两个身份上(review 反馈
 *    P1 第八轮)。
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
   * 原子独占发布**完整且持久**的标记:临时文件写完 + fsync → hard link 独占落位
   * → fsync 父目录。**'claimed' 与 'exists' 两种返回前都必须完成目录持久化**——
   * 输家不 flush 就接受对方标记,断电可能保住输家写的密文、丢掉标记(review 反馈
   * P1 第十二轮);flush 失败按 'error'(仅 Windows 因平台性打不开目录 fd 例外为
   * best-effort)。标记一旦可见内容即完整,不得出现零长度文件;
   * fsync 保证标记先于后续 profile/凭证写入持久化——否则断电后「标记消失 +
   * profile 非空」会被判成旧沙箱、用错钥匙覆盖既有密文(review 反馈 P1 第九轮)。
   * 已存在 → 'exists',其它失败 → 'error'。
   */
  claimMarker(name: string): 'claimed' | 'exists' | 'error';
  /**
   * profile 目录是否已有**真实数据**(读失败按 true,方向安全)。实现必须用
   * isKeychainIdentityMarkerArtifact 排除标记文件与其 .tmp 半成品。
   */
  profileHasData(): boolean;
  /**
   * fsync profile 目录,把已观察到的标记目录项持久化。**任何**对观察到标记的接受
   * (初读命中 / 有数据复查命中 / 认领竞态后读到胜者标记)都必须先经它确认——对手
   * link 后可能尚未完成自己的 fsync,不 flush 就接受,断电会保住本进程随后写的密文
   * 却丢掉标记(review 反馈 P1 第十三轮)。失败返回 false(仅 Windows 因平台性打不
   * 开目录 fd 可返回 true 作 best-effort)。
   */
  flushProfileDir(): boolean;
}

export type DevKeychainDecision =
  | { kind: 'rename'; appName: string }
  | { kind: 'keep-default' }
  /** 身份不确定(标记不可读/内容不可识别):必须终止启动,不得用任一身份写入。 */
  | { kind: 'abort'; reason: string };

function interpretMarker(
  read: KeychainMarkerRead,
  devName: string,
  io: KeychainIdentityIo,
): DevKeychainDecision | null {
  if (read.kind === 'unreadable') {
    return { kind: 'abort', reason: '身份标记读取失败(非 ENOENT)' };
  }
  if (read.kind === 'present') {
    if (read.value === devName) {
      // 接受观察到的标记前先把它的目录项持久化:写入者可能尚未完成自己的 fsync,
      // 不 flush 就以该身份写密文,断电后会出现「密文在、标记丢」(review 反馈
      // P1 第十三轮)。flush 失败按身份不确定 → abort。
      if (!io.flushProfileDir()) {
        return { kind: 'abort', reason: '身份标记持久化确认失败' };
      }
      return { kind: 'rename', appName: devName };
    }
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

  const first = interpretMarker(input.io.readMarker(), devName, input.io);
  if (first !== null) return first;

  if (input.io.profileHasData()) {
    // 无标记但有数据:复查标记,关掉「对手在首读后发布标记+数据」的并发窗口;
    // 复查确证 absent 才是真旧沙箱。
    const recheck = interpretMarker(input.io.readMarker(), devName, input.io);
    return recheck ?? { kind: 'keep-default' };
  }

  // 全新沙箱:原子认领。
  const claim = input.io.claimMarker(devName);
  if (claim === 'claimed') return { kind: 'rename', appName: devName };
  if (claim === 'exists') {
    const winner = interpretMarker(input.io.readMarker(), devName, input.io);
    // EEXIST 后复读确证 absent(对手发布后又消失)同样属身份不确定,拒绝启动。
    return winner ?? { kind: 'abort', reason: '认领竞态后身份标记消失' };
  }
  // 认领写失败(非 EEXIST 的瞬时错):身份不确定——并发对手可能恰好认领成功,
  // 「保持默认名」会让同一 profile 跑在两个身份上,统一按 abort 处理。
  return { kind: 'abort', reason: '身份标记认领失败(非竞态)' };
}
