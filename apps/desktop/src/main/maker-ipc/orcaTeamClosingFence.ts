/**
 * Orca 团队关闭 fence(#2093)。
 *
 * `end_team` 的关闭流程是多步串行写(逐 worker abort/close → markTeamEnded →
 * markWorkersStatusByTeam → archiveWorkersByTeam → 清 Lead orca_role),全程
 * 此前没有任何「正在关闭」的意图标记 —— close 与 archive 之间的窗口里,并发的
 * Worker send / switch_focus resume / lazy-bootstrap 会把刚关掉的 runtime 原地
 * 复活,留下「团队已终态、runtime 却活着」的孤儿(issue #2093;架构文档
 * 「done 确认与派活必须互斥」不变量的团队级缺口)。
 *
 * 本模块提供进程内的关闭意图闩锁,语义要点:
 *
 *  - **关闭意图优先于 runtime 状态**:闩锁存续期间,派发/恢复/懒创建入口必须
 *    结构化拒绝,不得 bootstrap;
 *  - **失败不自动清除**:关闭中途抛错/卡住时**不**调用 release —— 意图保留,
 *    复活窗口保持关闭,由显式重试或重启后的 orcaStrandedLeadReconcile 收敛
 *    (维护者裁决:超时/失败不能把 Worker 重新标成可恢复,#2093 行动 3);
 *  - **任一次成功完成即清除**:release 采用闩锁而非计数 —— 成功走完终态写盘
 *    意味着团队已终结,清除是安全的;这保证「失败一次 + 重试成功」能收敛解除,
 *    不会把 Lead 永久钉死;
 *  - 与 rehydrateCloseSuppression **刻意分开**:那是「这次 close 是替换不是
 *    拆除」的会话级单 bit;团队关闭是另一种生命周期标记,混用会扩大 rehydrate
 *    的窄保护(#2041;维护者行动 4)。
 *
 * worker 集在 begin 时快照登记(关闭流程本就先读 worker 列表再动手),重复
 * begin 同一 lead(双入口并发/失败后重试)合并快照集。
 */

const closingWorkersByLead = new Map<string, Set<string>>();
const closingLeadByWorker = new Map<string, string>();

/**
 * 登记团队关闭意图。返回幂等的 release —— **只在终态写盘全部完成后调用**;
 * 失败路径不要调用(见模块注释的收敛语义)。
 */
export function beginOrcaTeamClose(
  leadSessionId: string,
  workerSessionIds: readonly string[],
): () => void {
  const set = closingWorkersByLead.get(leadSessionId) ?? new Set<string>();
  for (const sid of workerSessionIds) {
    set.add(sid);
    closingLeadByWorker.set(sid, leadSessionId);
  }
  closingWorkersByLead.set(leadSessionId, set);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = closingWorkersByLead.get(leadSessionId);
    if (!current) return;
    for (const sid of current) {
      if (closingLeadByWorker.get(sid) === leadSessionId) closingLeadByWorker.delete(sid);
    }
    closingWorkersByLead.delete(leadSessionId);
  };
}

/** 该 Lead 的团队是否正在关闭(或上次关闭失败后意图仍保留)。 */
export function isOrcaTeamClosingForLead(leadSessionId: string): boolean {
  return closingWorkersByLead.has(leadSessionId);
}

/** 该 worker session 所属团队是否正在关闭(以 begin 时的快照集为准)。 */
export function isOrcaWorkerSessionTeamClosing(sessionId: string): boolean {
  return closingLeadByWorker.has(sessionId);
}

/** 测试专用:清空全部登记。 */
export function resetOrcaTeamClosingFenceForTest(): void {
  closingWorkersByLead.clear();
  closingLeadByWorker.clear();
}
