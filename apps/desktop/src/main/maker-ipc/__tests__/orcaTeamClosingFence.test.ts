/** 团队关闭 fence 的意图语义(#2093):意图优先于 runtime 状态,只显式释放。 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  beginOrcaTeamClose,
  isOrcaTeamClosingForLead,
  isOrcaWorkerSessionTeamClosing,
  resetOrcaTeamClosingFenceForTest,
} from '../orcaTeamClosingFence.js';

afterEach(() => {
  resetOrcaTeamClosingFenceForTest();
});

describe('orcaTeamClosingFence (#2093)', () => {
  it('begin 后 lead 与快照内的 worker 全部处于关闭态,release 后解除', () => {
    const release = beginOrcaTeamClose('lead-1', ['w-1', 'w-2']);
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(true);
    expect(isOrcaWorkerSessionTeamClosing('w-1')).toBe(true);
    expect(isOrcaWorkerSessionTeamClosing('w-2')).toBe(true);
    expect(isOrcaWorkerSessionTeamClosing('w-other')).toBe(false);
    expect(isOrcaTeamClosingForLead('lead-other')).toBe(false);

    release();
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(false);
    expect(isOrcaWorkerSessionTeamClosing('w-1')).toBe(false);
  });

  it('release 幂等:重复调用不产生负计数', () => {
    const release = beginOrcaTeamClose('lead-1', ['w-1']);
    release();
    release();
    const again = beginOrcaTeamClose('lead-1', ['w-1']);
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(true);
    again();
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(false);
  });

  it('失败一次(不 release)后重试成功可收敛解除:闩锁而非计数', () => {
    // 第一次关闭中途抛错 —— 失败路径不调用 release,意图保留。
    beginOrcaTeamClose('lead-1', ['w-1']);
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(true);

    // 显式重试:合并快照集;成功走完终态写盘后 release 一次即全部解除。
    const retryRelease = beginOrcaTeamClose('lead-1', ['w-1', 'w-2']);
    expect(isOrcaWorkerSessionTeamClosing('w-2')).toBe(true);
    retryRelease();
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(false);
    expect(isOrcaWorkerSessionTeamClosing('w-1')).toBe(false);
    expect(isOrcaWorkerSessionTeamClosing('w-2')).toBe(false);
  });

  it('没有任何超时自动清除:fence 只能显式释放(关闭意图优先于 runtime 状态)', async () => {
    beginOrcaTeamClose('lead-1', ['w-1']);
    // 模块刻意不含 setTimeout —— 等待任意 tick 后意图仍在。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isOrcaTeamClosingForLead('lead-1')).toBe(true);
    expect(isOrcaWorkerSessionTeamClosing('w-1')).toBe(true);
  });
});
