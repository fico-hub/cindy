/**
 * devKeychainName — 隔离 dev 实例的 safeStorage 钥匙串条目隔离(#871 候选 B 的收窄落地)。
 *
 * macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
 * (service = `<app.name> Safe Storage`),而 `app.name` 默认取 productName('Cindy'),
 * 三种身份(packaged cn / packaged global / 未打包 dev)共用同一条目:每种签名身份
 * 首次使用都会触发系统钥匙串授权弹窗,dev 的 stock Electron cdhash 也会进入正式
 * 条目的 ACL(#871)。
 *
 * 收窄语义 —— 只隔离显式声明隔离意图(`--isolated` / `XDT_ISOLATED=1`,即 devCliFlags
 * 的 `isolated === true`)的 dev 沙箱,且身份一经选定**随 profile 持久化并原子认领**:
 *  - 身份由 profile 根的标记文件(KEYCHAIN_IDENTITY_MARKER_FILE)承载:有标记按标记,
 *    跨重启粘住,不看目录内容(「目录为空」当持续判据会在第二次启动翻转身份,
 *    review 反馈 P1 第三轮)。
 *  - 无标记且 profile 已有数据:**再读一次标记**后才判旧沙箱——并发首启(如
 *    `--isolated --passive` 双进程、或单例锁尚未生效时)对手进程可能在本进程首次
 *    读标记之后写入了标记+数据,此时以标记为准,不与对手分叉(review 反馈 P1 第四轮)。
 *    复查仍无标记 = 本改动之前建的旧沙箱,永久保持默认条目名(存量密文绑定
 *    `Cindy Safe Storage` 主密钥,零迁移、零丢失)。
 *  - 无标记且 profile 为空 = 全新沙箱 → 用 O_EXCL(`wx`)**原子认领**标记:认领成功
 *    才改名;输掉竞态(已存在)则以胜者写入的标记为准;写失败不改名(保持旧行为,
 *    防「改了名但标记没落盘」的翻转窗口)。
 *  - 标记值不是已知身份 → 保守不改名(误判方向安全:保持改动前行为)。
 *  - 仅设 `XDT_USER_DATA_DIR`(目录覆写,无隔离意图)、共享 userData 的 dev、
 *    packaged cn/global 一律不改名:共享 profile 的存量密文必须沿用同一条目主密钥;
 *    packaged 改名属存量凭证迁移,须按 `credentials-and-local-storage.md` 单独设计
 *    (#871 候选 A)。
 *
 * 调用方(main 入口)必须**先显式 pin 住 userData** 再 `app.setName()`:改名只该影响
 * safeStorage 服务名与 dev-only 的派生路径(crashDumps 等),不得改变数据目录。
 */

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

/** 沙箱 profile 内的钥匙串身份标记文件名(userData 根下,纯文本存条目身份名)。 */
export const KEYCHAIN_IDENTITY_MARKER_FILE = 'keychain-identity';

/** 标记文件与 profile 的 IO 面(注入以便单测竞态时序)。 */
export interface KeychainIdentityIo {
  /** 标记内容(trim 后);不存在/读失败 → null。 */
  readMarker(): string | null;
  /** O_EXCL(`wx`)原子独占创建标记;已存在 → 'exists',其它失败 → 'error'。 */
  claimMarker(name: string): 'claimed' | 'exists' | 'error';
  /** profile 目录是否已有内容(读失败按 true,方向安全)。 */
  profileHasData(): boolean;
}

export function resolveDevKeychainAppName(input: {
  isPackaged: boolean;
  /** devCliFlags 解析结果:仅 --isolated / XDT_ISOLATED 表达的显式隔离意图。 */
  isolated: boolean;
  io: KeychainIdentityIo;
}): string | null {
  if (input.isPackaged) return null;
  if (!input.isolated) return null;
  const devName = BRAND_IDENTITY.executableNameByRegion.dev;

  const marker = input.io.readMarker();
  if (marker !== null) return marker === devName ? devName : null;

  if (input.io.profileHasData()) {
    // 无标记但有数据:复查标记,关掉「对手进程在首次读标记后写入标记+数据」的
    // 并发窗口;复查仍无标记才是真旧沙箱。
    const recheck = input.io.readMarker();
    return recheck === devName ? devName : null;
  }

  // 全新沙箱:原子认领。
  const claim = input.io.claimMarker(devName);
  if (claim === 'claimed') return devName;
  if (claim === 'exists') {
    const winner = input.io.readMarker();
    return winner === devName ? devName : null;
  }
  return null; // 写失败:不改名,保持旧行为。
}
