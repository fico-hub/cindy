import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// register.ts wires disableOrcaInternal inside one large closure with many runtime
// deps (maker, stores, caches), so the repo tests its IPC-boundary invariants via
// source assertion (see makerOrcaRoleMarking.test.ts / orcaWorkflowRoute.test.ts).
// The *behavioral* predicate (clear lead role iff no active team) is covered by
// orcaStrandedLeadReconcile.test.ts; here we lock down that disableOrcaInternal's
// "no active team" branch is no longer an unconditional no-op.
const registerSource = readFileSync(resolve(__dirname, '..', 'maker-ipc', 'register.ts'), 'utf8');

describe('disableOrcaInternal stranded-lead recovery', () => {
  it('extracts a shared clearLeadOrcaRoleState helper', () => {
    expect(registerSource).toContain(
      'async function clearLeadOrcaRoleState(leadSessionId: string)',
    );
  });

  it('reconciles a stranded lead in the "no active team" branch instead of plain no-op', () => {
    // The branch must consult the persisted role and clear it when still 'lead'.
    expect(registerSource).toContain('const role = await getSessionOrcaRole(leadSessionId);');
    expect(registerSource).toContain("if (role === 'lead') {");
  });

  it('also archives orphaned workers from non-active teams in the recovery branch', () => {
    // If the prior disable was interrupted before archiveWorkersByTeam, the lead's worker
    // sessions stay active+hidden+unreachable; the recovery must reconcile them too.
    const reconcileIndex = registerSource.indexOf(
      'await reconcileInactiveTeamWorkersForLead(leadSessionId)',
    );
    const recycleIndex = registerSource.indexOf(
      "await recycleSessionWorktreeForStatusChange(sid, 'archived', workerRecycleScope)",
      reconcileIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      reconcileIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(reconcileIndex);
    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(reconcileIndex);
  });

  it('fully cleans Host-owned worker runtimes after normal team archival', () => {
    expect(registerSource).toContain('await cancelIOSSimulatorSessionOperations(w.sessionId)');
    const archiveIndex = registerSource.indexOf(
      'const archivedWorkerSessionIds = await archiveWorkersByTeam(team.id)',
    );
    const recycleIndex = registerSource.indexOf(
      "recycleSessionWorktreeForStatusChange(sessionId, 'archived', workerRecycleScope)",
      archiveIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      archiveIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(archiveIndex);
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(archiveIndex);
  });

  it('runs full removed-session cleanup after archiving one worker', () => {
    const archiveIndex = registerSource.indexOf('await archiveSingleWorkerSession(sessionId);');
    const recycleIndex = registerSource.indexOf(
      "await recycleSessionWorktreeForStatusChange(sessionId, 'archived', workerRecycleScope);",
      archiveIndex,
    );
    const scopeIndex = registerSource.lastIndexOf(
      'const workerRecycleScope = captureSessionRecycleScope();',
      archiveIndex,
    );
    expect(scopeIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeLessThan(archiveIndex);
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(recycleIndex).toBeGreaterThan(archiveIndex);
  });

  it('reuses clearLeadOrcaRoleState on BOTH the normal-close and stranded-recovery paths', () => {
    const calls = registerSource.match(/await clearLeadOrcaRoleState\(leadSessionId\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// 团队关闭 fence(#2093)的时序不变量,同样以源码断言锁定(理由同文件头)。
describe('disableOrcaInternal team-closing fence (#2093)', () => {
  const disableBlock = registerSource.slice(
    registerSource.indexOf('async function disableOrcaInternal'),
    registerSource.indexOf('ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA'),
  );

  it('关闭意图在动手关 worker 之前登记(begin 在 close 循环前)', () => {
    const beginIndex = disableBlock.indexOf('beginOrcaTeamClose(');
    const closeLoopIndex = disableBlock.indexOf('for (const w of activeWorkers)');
    expect(beginIndex).toBeGreaterThan(-1);
    expect(closeLoopIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeLessThan(closeLoopIndex);
  });

  it('worker 关闭持有其 send route lock(与在途发送串行)', () => {
    expect(disableBlock).toContain('await withSendToSessionLock(w.sessionId, async () => {');
  });

  it('fence 只在终态写盘全部完成后释放(release 在 archive 与清 Lead 角色之后)', () => {
    const archiveIndex = disableBlock.indexOf('archiveWorkersByTeam(team.id)');
    const clearRoleIndex = disableBlock.indexOf('await clearLeadOrcaRoleState(leadSessionId);', archiveIndex);
    const releaseIndex = disableBlock.indexOf('releaseTeamClose();');
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(clearRoleIndex).toBeGreaterThan(archiveIndex);
    expect(releaseIndex).toBeGreaterThan(clearRoleIndex);
    // 失败路径不 release:块内不得出现 finally 里的 release(意图保留由重试收敛)。
    expect(disableBlock).not.toMatch(/finally[\s\S]{0,120}releaseTeamClose/);
  });

  it('复活入口挂上 fence 检查(resume 与 lazy-bootstrap)', () => {
    expect(registerSource).toContain(
      'if (isOrcaWorkerSessionTeamClosing(target.sessionId)) {',
    );
    expect(registerSource).toContain(
      'if (isOrcaWorkerSessionTeamClosing(targetSessionId)) {',
    );
    expect(registerSource).toContain(
      'isTeamClosing: (leadSessionId) => isOrcaTeamClosingForLead(leadSessionId),',
    );
  });
});
