/**
 * devKeychainName — 隔离 dev 实例的 safeStorage 钥匙串条目隔离(#871 候选 B 的收窄落地)。
 *
 * macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
 * (service = `<app.name> Safe Storage`),而 `app.name` 默认取 productName('Cindy'),
 * 三种身份(packaged cn / packaged global / 未打包 dev)共用同一条目:每种签名身份
 * 首次使用都会触发系统钥匙串授权弹窗,dev 的 stock Electron cdhash 也会进入正式
 * 条目的 ACL(#871)。
 *
 * 收窄语义 —— 只隔离「显式声明隔离意图 **且是全新沙箱**」的 dev 实例:
 *  - 隔离意图 = `--isolated` / `XDT_ISOLATED=1`(devCliFlags 解析出的
 *    `isolated === true`)。仅设 `XDT_USER_DATA_DIR` 是**目录覆写,不表达隔离意图**
 *    (devCliFlags 契约:isolated 保持 false,目录可能指向一份既有共享 profile)
 *    ——不改名(review 反馈 P1:按覆写目录改名会破坏「共享 profile 必须沿用同一
 *    钥匙串条目」的不变量)。
 *  - 全新沙箱 = userData 目录不存在**或为空**(pre-ready 时 Chromium 还没写 profile;
 *    repo 自带的 restart-desktop-remote.mjs 会在启动前 mkdirSync 预创建**空**目录,
 *    只看「存在」会把标准隔离启动路径全判成旧沙箱,门形同虚设——review 反馈 P1)。
 *    有内容才算旧版本用过的沙箱,保持默认条目名:它的存量 `.enc` 密文(登录态、
 *    手填 provider/MCP key、OAuth/IM 凭证)绑定 `Cindy Safe Storage` 主密钥,换名
 *    不仅读不出,重存还会覆盖唯一可恢复的旧密文(review 反馈 P1)——零迁移只对
 *    从未写过数据的新沙箱成立。误判方向安全:把新沙箱看成旧的只是保持改动前行为。
 *  - **共享** userData 的 dev(直跑 `pnpm dev:desktop`)同样不改名:共享 profile 里的
 *    存量密文只能用原条目主密钥解;若换名,dev 新写入的密文正式版也解不了,双向串坏。
 *  - packaged cn/global 维持现状(共用 'Cindy' 条目):改名属存量凭证迁移,按
 *    `docs/dev-rules/credentials-and-local-storage.md` 必须单独设计兼容/回滚/验证
 *    方案(#871 候选 A),不在本模块范围内。
 *
 * 调用方(main 入口)必须**先显式 pin 住 userData** 再 `app.setName()`:改名只该影响
 * safeStorage 服务名与 dev-only 的派生路径(crashDumps 等),不得改变数据目录。
 */

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

export function resolveDevKeychainAppName(input: {
  isPackaged: boolean;
  /** devCliFlags 解析结果:仅 --isolated / XDT_ISOLATED 表达的显式隔离意图。 */
  isolated: boolean;
  /**
   * 沙箱 userData 目录是否已有内容(调用方在 pin userData 后、ready 前用 fs 判定;
   * 不存在或为空 = 全新沙箱)。有内容 = 旧版本用过的沙箱,可能带着旧条目主密钥
   * 加密的存量密文 → 不改名。
   */
  userDataProfileHasData: boolean;
}): string | null {
  if (input.isPackaged) return null;
  if (!input.isolated) return null;
  if (input.userDataProfileHasData) return null;
  return BRAND_IDENTITY.executableNameByRegion.dev;
}
