/**
 * devKeychainMarkerIo.ts — KeychainIdentityIo 的真实文件系统实现(#871/#912)。
 *
 * 从 index.ts 顶层脚本抽出为可导出工厂(review 反馈 P1:手写 crash-consistency /
 * concurrency 协议最易在后续编辑中无声回归,匿名闭包无法直接测试),行为与抽取前
 * 逐字一致。协议契约(fsync 顺序、O_EXCL 回退、短写、撤销边界)见
 * devKeychainName.ts 的 KeychainIdentityIo 接口注释;本文件注释只讲实现取舍。
 *
 * fsOverrides 仅供集成测试注入:模拟不支持硬链接的文件系统(exFAT / 部分 SMB,
 * linkSync 抛非 EEXIST)与短写(writeSync 少写)。生产接线(index.ts)不传。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import { isKeychainIdentityMarkerArtifact, type KeychainIdentityIo } from './devKeychainName.js';

export interface KeychainMarkerIoDeps {
  /** 身份标记文件的绝对路径(profileDir 下的 KEYCHAIN_IDENTITY_MARKER_FILE)。 */
  markerPath: string;
  /** 沙箱 profile 目录(userData 覆写目录)。 */
  profileDir: string;
  /** 测试注入面:缺省用真实 fs。 */
  fsOverrides?: {
    linkSync?: typeof fs.linkSync;
    writeSync?: typeof fs.writeSync;
  };
}

export function createKeychainMarkerIo(deps: KeychainMarkerIoDeps): KeychainIdentityIo {
  const { markerPath, profileDir } = deps;
  const linkSync = deps.fsOverrides?.linkSync ?? fs.linkSync;
  const writeSync = deps.fsOverrides?.writeSync ?? fs.writeSync;

  // fsync profile 目录(claimMarker 与 flushProfileDir 共用同一实现)。
  const flushProfileDirImpl = (): boolean => {
    try {
      const dirFd = fs.openSync(profileDir, 'r');
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
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error('short write while publishing keychain identity marker');
      offset += written;
    }
  };

  return {
    // 把已观察到的标记目录项持久化;仅 Windows 因平台性打不开目录 fd 保持
    // best-effort(NTFS 日志语义不同,身份分离主要服务 macOS 钥匙串)。
    flushProfileDir: flushProfileDirImpl,
    readMarker: () => {
      try {
        // 原始内容不 trim:完整性(终止换行)由 resolver 判定。提前 trim 会把
        // O_EXCL 回退里写到一半的 "Cindy"(= "CindyDev\n" 前 5 字节)洗成完整
        // 的默认身份标记,并发读端据此分裂身份(review 反馈 P1 第十八轮)。
        // 只接受普通文件 + 有界读取:裸覆写目录可能存在同名**外来文件**——
        // 巨型文件无界读会耗尽内存,FIFO / 设备(或指向它们的符号链接)会把
        // main 启动永久阻塞(review 反馈 P2 第二十八轮)。O_NOFOLLOW 拒符号
        // 链接、O_NONBLOCK 防 FIFO 在 open 挂起;非普通文件与超限一律按
        // unreadable → abort(fail-safe 方向不变)。上限远大于词表最长合法
        // 内容("CindyDev\n" 9 字节),不影响任何正常标记。
        const fd = fs.openSync(
          markerPath,
          fs.constants.O_RDONLY |
            (fs.constants.O_NOFOLLOW ?? 0) |
            (fs.constants.O_NONBLOCK ?? 0),
        );
        try {
          if (!fs.fstatSync(fd).isFile()) return { kind: 'unreadable' };
          const maxBytes = 256;
          const buf = Buffer.alloc(maxBytes + 1);
          let total = 0;
          while (total < buf.length) {
            const n = fs.readSync(fd, buf, total, buf.length - total, total);
            if (n <= 0) break;
            total += n;
          }
          if (total > maxBytes) return { kind: 'unreadable' };
          const value = buf.subarray(0, total).toString('utf8');
          // 接受前把刚读到的内容自 fsync 落盘:O_EXCL 回退里写者的 fsync 可能
          // 尚未成功甚至失败,读者只做目录 fsync 就按内容接受的话,断电后可能
          // 「凭证已按该身份写入、标记内容却没落盘」(review 反馈 P1 第二十三轮)。
          // 自 fsync 成功 = 内容持久,与写者命运解耦。仅 Windows 因只读句柄平台性
          // fsync 受限保持 best-effort(与 flushProfileDir 的既有例外同款)。
          try {
            fs.fsyncSync(fd);
          } catch {
            if (process.platform !== 'win32') return { kind: 'unreadable' };
          }
          return { kind: 'present', value };
        } finally {
          fs.closeSync(fd);
        }
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
      // 临时文件名带随机成分且 'wx' 独占创建:仅 PID 后缀在 SMB 等多主机共享
      // 目录上会撞名(两台机器同 PID),'w' 打开还会截断对方的 tmp——若对方已把
      // 该 inode hard link 成最终标记,这里的重写会隔着共享 inode 改掉**已发布**
      // 的标记内容,认领结果与盘上真值分叉(review 反馈 P1 第二十五轮)。
      const tmpPath = `${markerPath}.${process.pid}-${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(profileDir, { recursive: true });
        const fd = fs.openSync(tmpPath, 'wx');
        try {
          writeMarkerContentSync(fd, name);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        // 目录项持久化——契约要求标记「完整且持久」后才允许选定 CindyDev。
        // 认领成功与输掉竞态(EEXIST)两条路径都必须先 flush(与 flushProfileDir
        // 同一实现);读路径的接受由 resolver 经 flushProfileDir 确认。
        let linkOutcome: 'claimed' | 'exists' | null;
        try {
          linkSync(tmpPath, markerPath);
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
            // 临时文件清理失败无害(随机后缀不冲突,残留会被 profileHasData 排除)。
          }
        }
        if (linkOutcome === null) {
          // 回退发布:O_EXCL 独占创建。排他性(防双身份的协调点)仍由文件系统
          // 原子原语保证;仅此路径牺牲「可见即完整」——读侧以终止换行为完整判据
          // (resolver 只接受 `<name>\n`,无换行前缀按不可识别 abort),半成品
          // 标记落在 fail-safe 方向。写入中途失败
          // 尽力撤销(标记归我们独占创建,他人不可能已认领),避免残留空标记把
          // 后续启动全部挡在 abort 上。
          try {
            const exclFd = fs.openSync(markerPath, 'wx');
            // 撤销只允许在**内容不完整**时做:内容一旦写满,并发读者可能已按完整
            // 标记接受并写入该身份的密文,此后 fsync 失败再 unlink 会造成「读者
            // 已用身份 + 标记消失 + profile 非空」→ 下次启动误判旧沙箱切回默认
            // 身份,双身份互写(review 反馈 P1 第二十三轮)。fsync 失败留完整标记
            // 并返回 'error'(本进程拒启):内容真值在盘上,后续启动读它自愈;
            // 持久性由读侧接受前的自 fsync 兜底(见 readMarker)。
            let contentComplete = false;
            try {
              writeMarkerContentSync(exclFd, name);
              contentComplete = true;
              fs.fsyncSync(exclFd);
            } catch (writeErr) {
              if (!contentComplete) {
                try {
                  fs.unlinkSync(markerPath);
                } catch {
                  // 撤销失败:残留半成品标记会让后续启动 abort 并给出处置指引,
                  // 仍是安全方向。
                }
                throw writeErr;
              }
              return 'error';
            } finally {
              fs.closeSync(exclFd);
            }
            linkOutcome = 'claimed';
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return 'error';
            linkOutcome = 'exists';
          }
        }
        if (!flushProfileDirImpl()) return 'error';
        return linkOutcome;
      } catch {
        return 'error';
      }
    },
    profileHasData: () => {
      try {
        // 排除标记文件与其 .tmp 半成品:它们是本机制自身产物,不构成旧沙箱证据。
        return fs.readdirSync(profileDir).some((entry) => !isKeychainIdentityMarkerArtifact(entry));
      } catch (err) {
        // 读失败(非 ENOENT)按「有数据」处理:误判方向安全,保持改动前行为。
        return (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
      }
    },
  };
}
