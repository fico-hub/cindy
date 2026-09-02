/**
 * useRemoteClaudeSubscriptionUsage — device-link 远程会话的被控端 Claude 订阅余量镜像。
 *
 * 与 useClaudeSubscriptionUsage(本机)的关系:数据语义与快照形状完全相同,但事实
 * 来源在**被控端**(turn 在被控端跑、消耗被控端订阅额度),所以:
 *   - warm-start 走 deviceLink.invoke(deviceId, 'maker:usage:claude-subscription')
 *     隧道读被控端 cached-first 快照(被控端 read() 自带节流的后台端点刷新);
 *   - 实时更新走 onRemotePush 的 'usage:claude-subscription-changed' 转发帧
 *     (被控端 broadcast tap → sessions topic,账号级、签名去抖);
 *   - 老被控端无此 channel → CHANNEL_NOT_ALLOWED → 返回 null,chip 保持原
 *     「仅会话金额」降级显示,不报错。
 *
 * 缓存按 deviceId 存 module-local Map:同设备的会话间切换不闪回占位态;push 的
 * null(被控端登出 / 换号清除)同步清对应设备缓存。owner 栅栏与其它 device-link
 * push 消费者同款(isDeviceLinkRemotePushCurrent),防止换号窗口期的旧帧串号。
 */

import { useEffect, useState } from 'react';

import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import { extractIpcError } from '@/utils/ipcError';

import type { ClaudeSubscriptionUsageSnapshot } from '../../shared/claudeSubscriptionUsage';

const REMOTE_CLAUDE_SUBSCRIPTION_CHANNEL = 'maker:usage:claude-subscription';
const REMOTE_CLAUDE_SUBSCRIPTION_CHANGED = 'usage:claude-subscription-changed';

const snapshotByDevice = new Map<string, ClaudeSubscriptionUsageSnapshot | null>();
/** 探测过 CHANNEL_NOT_ALLOWED 的老被控端:同一 renderer 生命周期内不再重复 invoke。 */
const unsupportedDevices = new Set<string>();
/** 挂载中的 hook 实例:invoke 回填 / push 到达时按 deviceId 通知重渲染。 */
const listenersByDevice = new Map<string, Set<(s: ClaudeSubscriptionUsageSnapshot | null) => void>>();

function isSnapshot(v: unknown): v is ClaudeSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function applySnapshot(deviceId: string, next: ClaudeSubscriptionUsageSnapshot | null): void {
  snapshotByDevice.set(deviceId, next);
  const listeners = listenersByDevice.get(deviceId);
  if (!listeners) return;
  for (const notify of listeners) notify(next);
}

/** 供单测重置 module 级缓存。 */
export function resetRemoteClaudeSubscriptionUsageCacheForTest(): void {
  snapshotByDevice.clear();
  unsupportedDevices.clear();
  listenersByDevice.clear();
}

/** push payload → 下一个缓存值:null 清空,快照覆盖,异常形状保留现值。 */
export function reduceRemoteClaudeSubscriptionPush(
  current: ClaudeSubscriptionUsageSnapshot | null,
  payload: unknown,
): ClaudeSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

/** 隧道读被控端 cached-first 快照并回填缓存;CHANNEL_NOT_ALLOWED 记入降级集合。 */
function fetchRemoteSnapshot(deviceId: string): void {
  if (unsupportedDevices.has(deviceId)) return;
  void window.electronAPI.deviceLink
    .invoke(deviceId, REMOTE_CLAUDE_SUBSCRIPTION_CHANNEL, [])
    .then((persisted) => {
      if (persisted === null || isSnapshot(persisted)) {
        applySnapshot(deviceId, persisted);
      }
      // 异常形状:保留现值,等 push 纠正。
    })
    .catch((err: unknown) => {
      // 老被控端:CHANNEL_NOT_ALLOWED 属预期降级,记录后不再探测;其余错误
      //(断链 / 超时)保留现值,等重连后的 push / 下次 mount 重试。
      const unsupported =
        extractIpcError(err)?.code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
        || (err instanceof Error && /\[(?:DEVICE_LINK_)?CHANNEL_NOT_ALLOWED\]/.test(err.message));
      if (unsupported) unsupportedDevices.add(deviceId);
    });
}

export function useRemoteClaudeSubscriptionUsage(
  deviceId: string | null,
): ClaudeSubscriptionUsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<ClaudeSubscriptionUsageSnapshot | null>(() =>
    deviceId ? snapshotByDevice.get(deviceId) ?? null : null,
  );

  // 注册通知 + warm-start。deviceId 变化时先同步切到新设备的缓存值。
  useEffect(() => {
    if (!deviceId) {
      setSnapshot(null);
      return;
    }
    setSnapshot(snapshotByDevice.get(deviceId) ?? null);
    let listeners = listenersByDevice.get(deviceId);
    if (!listeners) {
      listeners = new Set();
      listenersByDevice.set(deviceId, listeners);
    }
    listeners.add(setSnapshot);
    fetchRemoteSnapshot(deviceId);
    return () => {
      listeners.delete(setSnapshot);
      if (listeners.size === 0) listenersByDevice.delete(deviceId);
    };
  }, [deviceId]);

  // 实时镜像:被控端 broadcast tap 转发的账号级 push(sessions topic,常开订阅)。
  useEffect(() => {
    if (!deviceId) return;
    const off = window.electronAPI.deviceLink.onRemotePush((push, localOwnerStamp) => {
      if (push.channel !== REMOTE_CLAUDE_SUBSCRIPTION_CHANGED) return;
      if (push.deviceId !== deviceId) return;
      if (!isDeviceLinkRemotePushCurrent(push, localOwnerStamp)) return;
      applySnapshot(
        deviceId,
        reduceRemoteClaudeSubscriptionPush(snapshotByDevice.get(deviceId) ?? null, push.payload),
      );
    });
    return off;
  }, [deviceId]);

  return snapshot;
}

/**
 * 主动催一次被控端余量刷新(chip 悬念期用:倒计时归零等新快照)。被控端 read()
 * 自带 180s 节流 + 退避,重复调用安全;结果经缓存通知 + push 通道双路回流。
 */
export function requestRemoteClaudeSubscriptionRefresh(deviceId: string): void {
  fetchRemoteSnapshot(deviceId);
}
