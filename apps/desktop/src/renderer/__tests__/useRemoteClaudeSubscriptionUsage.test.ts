/**
 * useRemoteClaudeSubscriptionUsage 纯函数单测。
 *
 * reduceRemoteClaudeSubscriptionPush 与本机版 reduce 同一语义:null 清空(被控端
 * 登出 / 换号广播,远程 chip 必须回占位态,不得顶着上一个账号的余量)、快照覆盖、
 * 异常形状保留现值(隧道坏帧不清数据)。hook 的 invoke / push 装配路径由
 * TodaySpendChip 集成测试覆盖。
 */

import { describe, expect, it } from 'vitest';

import { reduceRemoteClaudeSubscriptionPush } from '../hooks/useRemoteClaudeSubscriptionUsage';

describe('reduceRemoteClaudeSubscriptionPush', () => {
  const current = { fiveHour: { utilization: 10 } };

  it('clears on null broadcasts (controlled device logged out / switched account)', () => {
    expect(reduceRemoteClaudeSubscriptionPush(current, null)).toBeNull();
  });

  it('replaces with pushed snapshots', () => {
    const next = { fiveHour: { utilization: 20 } };
    expect(reduceRemoteClaudeSubscriptionPush(current, next)).toBe(next);
  });

  it('keeps current value on malformed tunnel payloads', () => {
    expect(reduceRemoteClaudeSubscriptionPush(current, undefined)).toBe(current);
    expect(reduceRemoteClaudeSubscriptionPush(current, 'nope')).toBe(current);
    expect(reduceRemoteClaudeSubscriptionPush(current, [1, 2])).toBe(current);
  });
});
