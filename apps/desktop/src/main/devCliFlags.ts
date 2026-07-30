/**
 * Dev-only 启动参数解析。与 scripts/restart-desktop-remote.mjs 的 --passive /
 * --isolated 同义,供人类直接跑 `pnpm dev:desktop*` 时使用:desktop 的 dev 脚本
 * 以 `electron-forge start -- ` 收尾,pnpm 追加的参数经 forge 的 `--` 分隔符
 * 原样透传进 Electron 主进程 argv,由 index.ts 在 app ready 前调用本函数落地。
 * restart 脚本路径没有 argv,靠 XDT_ISOLATED=1(开关)+ XDT_ISOLATED_NAME(名字,
 * 可选)两个环境变量把隔离意图带进来——开关与名字分离,名字 "1" 也不会撞标记值。
 *
 * 隔离沙箱支持命名多开:`--isolated` 不带名字 = 默认沙箱(目录 <userData>-dev2、
 * 设备标识 dev-<指纹>);`--isolated=<名字>` = 独立命名沙箱(目录
 * <userData>-dev2-<名字>、设备标识 dev-<名字>-<指纹>),想开几个开几个,
 * 数据 / 登录态 / 设备身份互不干扰、也不碰正式版。
 *
 * 纯函数、零 electron 依赖 —— index.ts 注入 argv / env / 默认 userData 目录,
 * 便于单元测试。packaged 版本一律返回"无覆写",线上零影响。
 */
import { join, resolve } from 'node:path';

/**
 * 沙箱名字白名单:字母数字下划线连字符、≤32。同时约束两件事——
 * (a) 目录名跨平台安全;(b) 设备标识总长可控(server 端 Slack 设备注册的
 * deviceId 白名单是 /^[A-Za-z0-9_-]{1,64}$/,名字并入 deviceId 后不能超)。
 */
const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface DevCliFlagsInput {
  argv: readonly string[];
  isPackaged: boolean;
  /** 已显式设置的 XDT_USER_DATA_DIR;非空时优先于隔离模式的默认沙箱目录。 */
  envUserDataDir: string | undefined;
  /** app.getPath('userData') 的默认值;隔离模式在其后缀 '-dev2[-<名字>]' 生成沙箱目录。 */
  defaultUserDataDir: string;
  /**
   * XDT_ISOLATED 环境变量:严格 '1' = 隔离开关开,其它任何值(含 '0'/'false'/名字)
   * 一律视为关。名字**不**挤在这个变量里——否则名叫 "1" 的沙箱会和开关标记值撞车
   * (数据目录是命名的、deviceId 却派生成默认的,把互踢问题带回来,codex review P2)。
   */
  envIsolated: string | undefined;
  /** XDT_ISOLATED_NAME 环境变量:命名沙箱的名字(restart 脚本路径专用,与开关分离)。 */
  envIsolationName: string | undefined;
  /** 已显式设置的 XDT_DEVICE_ID_OVERRIDE;非空时隔离模式不再派生独立设备标识。 */
  envDeviceIdOverride: string | undefined;
  /** XDT_SCHEDULER_PASSIVE 环境变量:严格 '1' = 被动模式(restart 脚本路径)。 */
  envSchedulerPassive: string | undefined;
  /** XDT_ENDPOINTS_CDN 环境变量:严格 '1' = dev 也走完整 CDN 清单拉取(restart 脚本路径)。 */
  envEndpointsCdn: string | undefined;
}

export interface DevCliFlags {
  /** --passive:本实例定时任务不自动触发(scheduler-host 读 XDT_SCHEDULER_PASSIVE)。 */
  schedulerPassive: boolean;
  /** 是否由 --isolated / XDT_ISOLATED 明确进入独立 userData 沙箱。 */
  isolated: boolean;
  /**
   * 生效的 userData 覆写目录;null = 不覆写。来源优先级:
   * 显式 XDT_USER_DATA_DIR > 隔离模式默认沙箱目录(<userData>-dev2[-<名字>])> 不覆写。
   */
  userDataDirOverride: string | null;
  /**
   * 生效目录是否等于纪元派生路径(<userData>-dev2[-<名字>];含 restart 脚本经 env
   * 传入同一路径的标准流程)。CindyDev 钥匙串身份只允许落在纪元目录上——显式指向
   * 其它目录的隔离启动不标记,防同一目录被多种启动形态以两种身份打开。
   */
  isolatedDirIsEpochDerived: boolean;
  /**
   * 隔离模式且未显式给 XDT_DEVICE_ID_OVERRIDE 时为 true:调用方应派生独立
   * deviceId(dev-[<名字>-]<机器指纹>)。为什么必须派生:服务端 refresh token 按
   * (user, device) 一对一存,沙箱实例若沿用物理机指纹登录,会覆盖正式版的
   * 续期凭证 → 正式版下次续期时被登出(同机互踢)。
   */
  needsIsolatedDeviceId: boolean;
  /** 命名沙箱的名字;默认沙箱 / 未隔离时为 null。 */
  isolationName: string | null;
  /**
   * --isolated=<名字> 的名字不合法(字符集 / 长度)时原样带出,调用方应警告。
   * 此时按**默认沙箱**处理(仍隔离——回落到不隔离会直接混进正式版数据,更危险)。
   */
  invalidIsolationName: string | null;
  /**
   * --endpoints-cdn / XDT_ENDPOINTS_CDN=1:dev 下不读本地 config/endpoint.json,
   * 走与 packaged 完全相同的 CDN 阻断拉取链路(测线上清单用)。packaged 恒 false
   * (本来就走 CDN,该标志无意义)。
   */
  endpointsCdn: boolean;
}

/**
 * 是否获取 Electron single-instance lock。
 *
 * 正常 dev 与 packaged 各自保持单实例（锁作用域见
 * `resolveSingleInstanceLockUserDataDir`，dev 与 packaged 分域、互不阻塞），
 * 确保同 flavor 的 deep link 能交给已运行窗口；`--passive` 是明确的共享数据
 * 多开契约，所有 passive dev 都跳过获取。packaged 永远锁定，不能被环境变量
 * 误切成多实例。
 */
export function shouldRequestSingleInstanceLock(input: {
  isPackaged: boolean;
  schedulerPassive: boolean;
}): boolean {
  return input.isPackaged || !input.schedulerPassive;
}

/**
 * single-instance lock 的作用域目录（Electron 锁按调用时的 userData 路径生成）。
 *
 * packaged 用真实 userData —— release 之间单实例，双击第二份安装包会聚焦已运行
 * 窗口。dev 用 `<userData>/dev-single-instance-lock` 子目录 —— dev 之间仍单实例
 * （深链 second-instance redirect 保持有效），但**不再与共库的正式版互斥**：
 * dev + release 共享 userData 双开是明确支持的工作流（2026-07-19 dev 改为与
 * packaged 抢同一把锁曾误伤该工作流，2026-07-20 按 flavor 分域恢复）。跨实例
 * 并发由 SQLite WAL + busy_timeout、scheduler DB 级原子认领、auth
 * replacement-retry 等既有仲裁收敛，与 `--passive` 共库多开走的是同一套机制。
 * `--isolated` 沙箱的 userData 本身独立，锁子目录随之独立，语义不变。
 */
export function resolveSingleInstanceLockUserDataDir(input: {
  isPackaged: boolean;
  userDataDir: string;
}): string {
  return input.isPackaged
    ? input.userDataDir
    : join(input.userDataDir, 'dev-single-instance-lock');
}

/**
 * passive 只有在共享 userData 时才需要禁止 migration。
 *
 * 显式 isolated 沙箱没有其它实例替它初始化数据库，仍按正常启动路径迁移；packaged
 * 不接受任何 dev-only passive 语义。调用方会把这个纯判定同步成内部 env，供延后加载
 * 的 localDb 模块在首次打开用户数据库时执行硬闸。
 */
export function shouldEnforcePassiveMigrationCompatibility(input: {
  isPackaged: boolean;
  schedulerPassive: boolean;
  isolated: boolean;
}): boolean {
  return !input.isPackaged && input.schedulerPassive && !input.isolated;
}

export function resolveDevCliFlags(input: DevCliFlagsInput): DevCliFlags {
  if (input.isPackaged) {
    return {
      schedulerPassive: false,
      isolated: false,
      userDataDirOverride: null,
      isolatedDirIsEpochDerived: false,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    };
  }

  // 隔离意图与名字:argv 优先(human 直跑路径),env 兜底(restart 脚本路径)。
  let isolated = false;
  let isolationName: string | null = null;
  let invalidIsolationName: string | null = null;
  for (const arg of input.argv) {
    if (arg === '--isolated') {
      isolated = true;
    } else if (arg.startsWith('--isolated=')) {
      isolated = true;
      const raw = arg.slice('--isolated='.length);
      if (ISOLATION_NAME_RE.test(raw)) isolationName = raw;
      else invalidIsolationName = raw;
    }
  }
  // env 路径:开关严格等于 '1' 才生效('0'/'false'/其它值都视为关,不做布尔猜测),
  // 名字单独走 XDT_ISOLATED_NAME——开关与名字分离,任何合法名字(包括 '1')都能用。
  if (!isolated && input.envIsolated === '1') {
    isolated = true;
    const rawName = input.envIsolationName?.trim();
    if (rawName) {
      if (ISOLATION_NAME_RE.test(rawName)) isolationName = rawName;
      else invalidIsolationName = rawName;
    }
  }

  const envDir = input.envUserDataDir?.trim() ? input.envUserDataDir : undefined;
  // 目录纪元 v2(-dev2):#871 起隔离沙箱使用独立的 CindyDev 钥匙串身份;旧
  // `-dev[-<名字>]` 目录属 Cindy 身份纪元,**留给旧 checkout 继续用**——同名目录
  // 被新旧 checkout 轮流以两种钥匙串身份打开会互毁密文(#912 review),换目录做
  // 物理隔离,新旧 checkout 各开各的沙箱。
  const epochDerivedDir = `${input.defaultUserDataDir}-dev2${isolationName ? `-${isolationName}` : ''}`;
  let userDataDirOverride: string | null = envDir ?? null;
  if (isolated && !envDir) {
    userDataDirOverride = epochDerivedDir;
  }
  // CindyDev 身份只允许落在纪元派生目录上:restart 脚本经 env 传入的标准路径与
  // 本地派生一字不差,同样命中;用户显式指向**任意其它目录**(可能是共享中的既有
  // profile,或会被无隔离/旧 checkout 启动形态打开的目录)则不标记——否则同一目录
  // 在「--isolated + 显式覆写」与「裸覆写 / 旧 checkout」两种受支持启动形态之间
  // 会被两种钥匙串身份轮流打开(#912 review P1 第十二轮)。
  // 判等按规范化路径:尾斜杠 / '.' 段 / Windows 大小写差异都指向同一实际目录,
  // 字符串全等会把标准纪元目录的等价写法误判成"其它目录"→ 观察模式给空沙箱抢注
  // 默认身份标记,该沙箱**永久**回到共享 Cindy 钥匙串(#912 review P2 第十九轮)。
  // 误判方向的代价不对称:等价写法漏判丢隔离且不可逆;真不同目录本就不该命中。
  const normalizeForEpochCompare = (p: string): string => {
    const resolved = resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const isolatedDirIsEpochDerived =
    isolated &&
    userDataDirOverride !== null &&
    normalizeForEpochCompare(userDataDirOverride) === normalizeForEpochCompare(epochDerivedDir);
  return {
    schedulerPassive: input.argv.includes('--passive') || input.envSchedulerPassive === '1',
    isolated,
    userDataDirOverride,
    isolatedDirIsEpochDerived,
    needsIsolatedDeviceId: isolated && !input.envDeviceIdOverride?.trim(),
    isolationName,
    invalidIsolationName,
    // argv 优先(human 直跑),env 兜底(restart 脚本路径);与 --passive 同款双通道。
    endpointsCdn: input.argv.includes('--endpoints-cdn') || input.envEndpointsCdn === '1',
  };
}
