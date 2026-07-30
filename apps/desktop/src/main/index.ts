// Entry: Electron startup → bootstrap-electron.ts (dynamic import).
import fixPath from 'fix-path';
import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { exit, stderr } from 'node:process';
import { CURRENT_CINDY_REGION } from '../shared/brandRegion.js';
import { resolveRegionUserDataDirName } from './regionUserData.js';
import { createLogger, initLogger } from './logger.js';
import { beginDesktopDevInstance, type DesktopDevMode } from './devStartupStatus.js';
import { ensureSystemBinPathForMachineId } from './deviceId.js';

// 同机双装(cn/global):global 构建把 userData 切到区域目录(CindyGlobal),
// 与 cn 版(productName 默认 'Cindy')彻底分库;数据库 / 登录态 / 单实例锁 /
// sessionData 随 userData 目录天然隔离。必须在 initLogger()(packaged 日志
// 目录)、crashReporter、单实例锁与一切 userData 读取之前执行。cn 构建与
// dev 返回 null,零行为变化(dev 隔离语义由下方 devCliFlags 的 --isolated 承载)。
const regionUserDataDirName = resolveRegionUserDataDirName({
  isPackaged: app.isPackaged,
  region: CURRENT_CINDY_REGION,
  argv: process.argv,
});
if (regionUserDataDirName) {
  app.setPath('userData', path.join(app.getPath('appData'), regionUserDataDirName));
}

// Node happy-eyeballs(autoSelectFamily)默认每个地址只给 250ms 完成 TCP 握手,
// VPN/高 RTT 链路上直连海外端点(platform.claude.com 换 token、订阅模式模型流量等)
// 的合法握手常超过 250ms,所有地址族全被掐掉后 undici 只报一个裸 'fetch failed'。
// 与 voice-input/refinerHttpDispatcher.ts 的 per-pool 配置同值(2500ms),这里设
// 进程级默认值,兜住 main 里所有不走自建 dispatcher 的 fetch / net.connect。
setDefaultAutoSelectFamilyAttemptTimeout(2500);

initLogger();
const log = createLogger('fix-path');
log.debug(`[fix-path] before PATH=${process.env.PATH ?? ''}`);
fixPath();
log.debug(`[fix-path] after PATH=${process.env.PATH ?? ''}`);

// Guarantee /usr/sbin:/sbin are on PATH before anything resolves the device id.
// A Finder/Dock-launched GUI process inherits a minimal PATH without them, so
// node-machine-id's bare `ioreg` isn't found and machineIdSync() throws — which,
// read at authManager's module top, crashed the whole app on launch (0.1.14).
// Must run before bootstrap-electron (and thus authManager) is imported below.
ensureSystemBinPathForMachineId();

// !! 必须在 dispatch() 之前同步执行 !!
// 把用户系统(HKCU / shell rc)注入到本进程 process.env 上的 Anthropic / Claude Code
// 体系 env 全部清掉,避免泄漏到我们 spawn 的 CC CLI 子进程。
// 字段列表 + 原理见 maker-core/agents/claude-code/env-builder.ts 里的
// SENSITIVE_ANTHROPIC_ENV_KEYS 注释。
//
// 这里同步 import 不走动态 import,确保 strip 在任何 module top-level 代码读
// process.env 之前执行。
import { stripSensitiveAnthropicEnv } from '@cindy/maker-core';

// device-link 远程控制:必须在任何 ipcMain.handle 调用之前 monkey-patch,
// 才能捕获到全量 channel → handler 映射(供被控端 dispatch 远程 invoke)。
// import 在 ESM 里被 hoist,patch 在 bootstrap-electron 动态 import(其内部注册
// 所有 handler)之前完成。
import { installInvokeCapture } from './device-link/invoke-registry.js';

const stripped = stripSensitiveAnthropicEnv();
if (stripped.length > 0) {
  stderr.write(`[cindy] stripped user-level Anthropic env: ${stripped.join(', ')}\n`);
}

installInvokeCapture();

// dev-only 启动覆写(与 scripts/restart-desktop-remote.mjs 的 --passive/--isolated
// 同义,人类直跑 pnpm dev:desktop* 时参数经 electron-forge 的 `--` 透传到这里,
// restart 脚本路径经 XDT_ISOLATED=1 环境变量声明隔离意图):
//   - XDT_USER_DATA_DIR / --isolated:userData 切独立目录 —— 多实例不抢 SQLite 锁
//     (device-link 联调)、或与正式版彻底分家(--isolated 默认 <userData>-dev)。
//   - 隔离模式同时派生独立 deviceId(dev-<机器指纹>):服务端 refresh token 按
//     (user, device) 一对一存,沙箱沿用物理机指纹登录会覆盖正式版的续期凭证,
//     导致正式版下次续期被登出(同机互踢);显式设 XDT_DEVICE_ID_OVERRIDE 时尊重用户值。
//   - --passive / XDT_SCHEDULER_PASSIVE:定时任务自动触发让位给同机另一实例。
// 必须在 app 'ready' 前调用。仅 dev(非 packaged)生效,生产忽略,零线上影响。
import { machineIdSync } from 'node-machine-id';
import {
  resolveDevCliFlags,
  shouldEnforcePassiveMigrationCompatibility,
} from './devCliFlags.js';
import {
  KEYCHAIN_IDENTITY_MARKER_FILE,
  isKeychainIdentityMarkerArtifact,
  resolveDevKeychainDecision,
} from './devKeychainName.js';

const devFlags = resolveDevCliFlags({
  argv: process.argv,
  isPackaged: app.isPackaged,
  envUserDataDir: process.env.XDT_USER_DATA_DIR,
  defaultUserDataDir: app.getPath('userData'),
  envIsolated: process.env.XDT_ISOLATED,
  envIsolationName: process.env.XDT_ISOLATED_NAME,
  envDeviceIdOverride: process.env.XDT_DEVICE_ID_OVERRIDE,
  envSchedulerPassive: process.env.XDT_SCHEDULER_PASSIVE,
  envEndpointsCdn: process.env.XDT_ENDPOINTS_CDN,
});
if (devFlags.schedulerPassive) {
  // 统一收敛到 env:scheduler-host 只认 XDT_SCHEDULER_PASSIVE,不重复解析 argv。
  process.env.XDT_SCHEDULER_PASSIVE = '1';
  stderr.write('[cindy] dev scheduler passive mode (--passive)\n');
}
if (shouldEnforcePassiveMigrationCompatibility({
  isPackaged: app.isPackaged,
  schedulerPassive: devFlags.schedulerPassive,
  isolated: devFlags.isolated,
})) {
  // 内部启动契约：共享 userData 的 passive dev 只能打开与当前 checkout migration
  // 完全一致的数据库，且不得自行迁移。localDb 在用户数据库首次打开时消费本标记。
  process.env.XDT_PASSIVE_SHARED_USER_DATA = '1';
} else {
  // 防止 shell 中同名 ambient env 污染 packaged / isolated 启动语义。
  delete process.env.XDT_PASSIVE_SHARED_USER_DATA;
}
if (devFlags.endpointsCdn) {
  // 统一收敛到 env:clientEndpointsService 只认 XDT_ENDPOINTS_CDN,不重复解析 argv。
  process.env.XDT_ENDPOINTS_CDN = '1';
  stderr.write('[cindy] dev endpoints via CDN (--endpoints-cdn)\n');
}
if (devFlags.userDataDirOverride) {
  // 同步回 env,让读 env 的下游(日志、诊断)与实际生效目录一致。
  process.env.XDT_USER_DATA_DIR = devFlags.userDataDirOverride;
  app.setPath('userData', devFlags.userDataDirOverride);
  stderr.write(`[cindy] dev userData override → ${devFlags.userDataDirOverride}\n`);
  // 隔离 dev 独立钥匙串条目(#871 候选 B 收窄):userData 已在上一行显式 pin,
  // 改名只影响 safeStorage 服务名(`<app.name> Safe Storage`)与 dev-only 派生
  // 路径(crashDumps 等),不改数据目录。身份由 profile 标记文件粘住并原子认领;
  // 标记不可读/内容不可识别 = 身份不确定 → 拒绝启动(静默回退默认身份会用错
  // 钥匙覆盖既有密文)。决策全逻辑与边界见 devKeychainName.ts。
  const keychainMarkerPath = path.join(devFlags.userDataDirOverride, KEYCHAIN_IDENTITY_MARKER_FILE);
  // fsync profile 目录(claimMarker 与 io.flushProfileDir 共用同一实现)。
  const flushProfileDirForClaim = (): boolean => {
    try {
      const dirFd = fs.openSync(devFlags.userDataDirOverride!, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
      return true;
    } catch {
      return process.platform === 'win32';
    }
  };
  // writeSync 允许短写(配额/磁盘/网络文件系统压力下不抛错而少写)。短写发布的
  // 截断标记可能恰好是词表里另一个合法身份("CindyDev\n" 截 5 字节 = "Cindy"),
  // 认领进程与后续启动会各选一个身份(review 反馈 P1 第十七轮)——必须写满才算
  // 写完;无进展按写失败抛出,走各自的 error/撤销路径。
  const writeMarkerContentSync = (fd: number, name: string): void => {
    const data = Buffer.from(`${name}\n`, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error('short write while publishing keychain identity marker');
      offset += written;
    }
  };
  const keychainDecision = resolveDevKeychainDecision({
    isPackaged: app.isPackaged,
    // CindyDev 身份只在「显式隔离 + 纪元派生目录」下认领;其余覆写形态(裸覆写 /
    // 指向非纪元目录的隔离启动)走观察模式——不认领,但目录已带标记时依标记运行,
    // 防同一目录被不同启动形态以两种身份轮流打开(review 反馈 P1 第十二/十四轮)。
    isolated: devFlags.isolated && devFlags.isolatedDirIsEpochDerived,
    hasDirOverride: true,
    io: {
      // 把已观察到的标记目录项持久化;仅 Windows 因平台性打不开目录 fd 保持
      // best-effort(NTFS 日志语义不同,身份分离主要服务 macOS 钥匙串)。
      flushProfileDir: flushProfileDirForClaim,
      readMarker: () => {
        try {
          const value = fs.readFileSync(keychainMarkerPath, 'utf8').trim();
          return { kind: 'present', value };
        } catch (err) {
          return (err as NodeJS.ErrnoException)?.code === 'ENOENT'
            ? { kind: 'absent' }
            : { kind: 'unreadable' };
        }
      },
      claimMarker: (name) => {
        // 原子发布完整标记:先写临时文件并 fsync,再 hard link 独占落位,最后 fsync
        // 父目录——link 既是排他认领(EEXIST = 输掉竞态)又保证可见即完整;fsync 保证
        // 标记先于后续任何 profile/凭证写入持久化,否则断电后「标记消失 + profile
        // 非空」会被下次启动判成旧沙箱、用错钥匙覆盖 CindyDev 密文(review 反馈)。
        const tmpPath = `${keychainMarkerPath}.${process.pid}.tmp`;
        try {
          fs.mkdirSync(devFlags.userDataDirOverride!, { recursive: true });
          const fd = fs.openSync(tmpPath, 'w');
          try {
            writeMarkerContentSync(fd, name);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          // 目录项持久化——契约要求标记「完整且持久」后才允许选定 CindyDev。
          // 认领成功与输掉竞态(EEXIST)两条路径都必须先 flush(与 io.flushProfileDir
          // 同一实现);读路径的接受由 resolver 经 io.flushProfileDir 确认。
          let linkOutcome: 'claimed' | 'exists' | null;
          try {
            fs.linkSync(tmpPath, keychainMarkerPath);
            linkOutcome = 'claimed';
          } catch (err) {
            // 非 EEXIST 不立即判 error:覆写目录可能落在不支持硬链接的文件系统上
            // (exFAT 卷 / 部分 SMB 共享,link 报 EPERM/ENOTSUP 等),这些路径此前
            // 可正常启动,不能因发布机制升级而拒启(review 反馈 P1 第十六轮)。
            linkOutcome = (err as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'exists' : null;
          } finally {
            try {
              fs.unlinkSync(tmpPath);
            } catch {
              // 临时文件清理失败无害(pid 后缀不冲突)。
            }
          }
          if (linkOutcome === null) {
            // 回退发布:O_EXCL 独占创建。排他性(防双身份的协调点)仍由文件系统
            // 原子原语保证;仅此路径牺牲「可见即完整」——读侧三态 + 内容不可识别
            // 即 abort 本就把不完整标记按 fail-safe 处理,方向安全。写入中途失败
            // 尽力撤销(标记归我们独占创建,他人不可能已认领),避免残留空标记把
            // 后续启动全部挡在 abort 上。
            try {
              const exclFd = fs.openSync(keychainMarkerPath, 'wx');
              try {
                writeMarkerContentSync(exclFd, name);
                fs.fsyncSync(exclFd);
              } catch (writeErr) {
                try {
                  fs.unlinkSync(keychainMarkerPath);
                } catch {
                  // 撤销失败:残留标记会让后续启动 abort 并给出处置指引,仍是安全方向。
                }
                throw writeErr;
              } finally {
                fs.closeSync(exclFd);
              }
              linkOutcome = 'claimed';
            } catch (err) {
              if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return 'error';
              linkOutcome = 'exists';
            }
          }
          if (!flushProfileDirForClaim()) return 'error';
          return linkOutcome;
        } catch {
          return 'error';
        }
      },
      profileHasData: () => {
        try {
          // 排除标记文件与其 .tmp 半成品:它们是本机制自身产物,不构成旧沙箱证据。
          return fs
            .readdirSync(devFlags.userDataDirOverride!)
            .some((entry) => !isKeychainIdentityMarkerArtifact(entry));
        } catch (err) {
          // 读失败(非 ENOENT)按「有数据」处理:误判方向安全,保持改动前行为。
          return (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
        }
      },
    },
  });
  if (keychainDecision.kind === 'abort') {
    stderr.write(
      `[cindy] FATAL: 沙箱钥匙串身份不确定(${keychainDecision.reason});` +
        `为避免用错误主密钥覆盖沙箱既有密文,拒绝启动。\n` +
        `  标记文件: ${keychainMarkerPath}\n` +
        `  处置: 若确认该沙箱从未用过 CindyDev 身份,删除该标记文件后重启` +
        `(或将内容修复为 "Cindy");若沙箱曾以 CindyDev 运行,修复其内容为 "CindyDev"。\n`,
    );
    exit(1);
  }
  if (keychainDecision.kind === 'rename') {
    app.setName(keychainDecision.appName);
    stderr.write(`[cindy] dev keychain isolation → app.name=${keychainDecision.appName}\n`);
  }
}
if (devFlags.invalidIsolationName !== null) {
  // 名字不合法(字符集 / 长度)→ 已按默认沙箱处理(回落到不隔离会混进正式版
  // 数据,更危险),这里只大声警告,让用户发现自己起错了名字。
  stderr.write(
    `[cindy] WARN: invalid --isolated name "${devFlags.invalidIsolationName}"` +
      ' (allowed: A-Za-z0-9_-, max 32 chars); falling back to the DEFAULT sandbox\n',
  );
}
if (devFlags.needsIsolatedDeviceId) {
  // 必须在 authManager 模块加载(bootstrap 动态 import)之前落到 env——它在模块
  // 顶层读一次 XDT_DEVICE_ID_OVERRIDE ?? machineIdSync()。机器指纹极小概率取不到
  // (machineIdSync 抛),兜底用固定串:跨机器同账号双沙箱会撞,但比静默回落物理机
  // 指纹(必踢正式版)安全方向正确。
  // 长度硬预算 64:server 端 Slack 设备注册的 deviceId 白名单上限 64 字符
  // (apps/server/src/routes/slack.ts),超长会被静默降级成 legacy 伪设备。
  // 默认沙箱 'dev-' + 60 位指纹 = 64;命名沙箱 'dev-<名字>-' + 剩余预算的指纹
  // (名字 ≤32 → 指纹 ≥27 位 = 108 bit 熵,唯一性依然充裕)。
  const nameSegment = devFlags.isolationName ? `${devFlags.isolationName}-` : '';
  let isolatedDeviceId: string;
  try {
    const hashBudget = 60 - nameSegment.length; // 'dev-'(4) + nameSegment + hash = 64
    isolatedDeviceId = `dev-${nameSegment}${machineIdSync().slice(0, hashBudget)}`;
  } catch {
    isolatedDeviceId = `isolated-dev${devFlags.isolationName ? `-${devFlags.isolationName}` : ''}`;
  }
  process.env.XDT_DEVICE_ID_OVERRIDE = isolatedDeviceId;
  stderr.write(`[cindy] dev isolated deviceId → ${isolatedDeviceId}\n`);
}

// 实例注册表对 dev 与 packaged 一律登记:dev/release 按 flavor 分锁域、共享同一
// userData 双开是受支持的工作流(bootstrap-electron 单例锁注释),owner-namespace
// 迁移的独占检查靠本注册表发现「还有谁共享这份 userData」——packaged 不登记的话,
// dev 实例会在 release 实例仍存活时误判独占并搬走 legacy 配置。
{
  const rootDir = app.isPackaged
    ? path.resolve(app.getAppPath())
    : path.resolve(app.getAppPath(), '..', '..');
  let commit: string | null = null;
  if (!app.isPackaged) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      // Source provenance remains useful without a commit in exported/unusual checkouts.
    }
  }
  const declaredMode = process.env.XDT_DESKTOP_DEV_MODE;
  const mode: DesktopDevMode = declaredMode === 'remote' || declaredMode === 'local'
    ? declaredMode
    : 'unknown';
  const cleanupDevInstance = beginDesktopDevInstance({
    userDataDir: app.getPath('userData'),
    rootDir,
    commit,
    mode,
    passive: devFlags.schedulerPassive,
    isolated: Boolean(devFlags.userDataDirOverride),
  });
  app.once('will-quit', cleanupDevInstance);
}

async function dispatch(): Promise<void> {
  const mod = await import('./bootstrap-electron.js');
  await mod.bootstrapElectron();
}

dispatch().catch((err) => {
  stderr.write(`[cindy] fatal: ${(err as Error).stack ?? err}\n`);
  exit(1);
});
