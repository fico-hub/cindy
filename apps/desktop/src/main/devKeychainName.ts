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
 * 的 `isolated === true`)的 dev 沙箱,且身份一经选定**随 profile 持久化**:
 *  - 沙箱身份由 profile 内的标记文件(KEYCHAIN_IDENTITY_MARKER_FILE)承载,首启选定
 *    CindyDev 时由调用方**先成功写入标记再改名**;此后每次启动读标记粘住同一身份。
 *    不能用「目录是否为空」当持续判据——首启写入数据后第二次启动目录必然非空,
 *    身份会翻转回 Cindy,让首启写的密文全部报废(review 反馈 P1 第三轮)。
 *  - 无标记且 profile 已有数据 = 本改动之前建的旧沙箱:存量 `.enc` 密文绑定
 *    `Cindy Safe Storage` 主密钥,永久保持默认条目名(零迁移、零丢失)。
 *  - 无标记且 profile 为空(或目录不存在;repo 的 restart-desktop-remote.mjs 会
 *    预创建**空**目录)= 全新沙箱 → 选定 CindyDev。
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

export function resolveDevKeychainAppName(input: {
  isPackaged: boolean;
  /** devCliFlags 解析结果:仅 --isolated / XDT_ISOLATED 表达的显式隔离意图。 */
  isolated: boolean;
  /** 标记文件内容(trim 后);不存在/读失败 → null。 */
  markerIdentity: string | null;
  /** profile 目录是否已有内容(标记文件之外的判据只在无标记时使用)。 */
  profileHasData: boolean;
}): string | null {
  if (input.isPackaged) return null;
  if (!input.isolated) return null;
  const devName = BRAND_IDENTITY.executableNameByRegion.dev;
  // 已初始化为 CindyDev 的沙箱:身份跨重启粘住(标记为准,不再看目录内容)。
  if (input.markerIdentity === devName) return devName;
  // 未知标记值:保守不改名。
  if (input.markerIdentity !== null) return null;
  // 无标记且有数据 = 本改动之前建的旧沙箱,永久保持默认条目名。
  if (input.profileHasData) return null;
  // 全新沙箱:选定 CindyDev(调用方须先成功持久化标记再改名,防写失败后身份翻转)。
  return devName;
}
