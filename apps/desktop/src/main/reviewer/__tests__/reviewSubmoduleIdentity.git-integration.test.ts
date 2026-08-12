import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 60_000 });

import { runGit } from '../../git-review/gitRunner';
import { readReviewSubmoduleIdentity } from '../reviewSubmoduleIdentity';

let workRoot: string;
let parentPath: string;

// CI runner 没有全局 git 身份;每个会执行 commit 的仓库(含 submodule 克隆)都要配本地身份。
async function configureRepo(dir: string): Promise<void> {
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(['init'], { cwd: dir });
  await configureRepo(dir);
}

/** 父仓 + 已初始化 submodule(vendor/lib,含一个已提交文件 inner.txt)。 */
async function setupParentWithSubmodule(): Promise<{ parent: string; sub: string }> {
  const upstream = path.join(workRoot, 'lib-upstream');
  await initRepo(upstream);
  await fs.writeFile(path.join(upstream, 'inner.txt'), 'inner-v1\n');
  await runGit(['add', 'inner.txt'], { cwd: upstream });
  await runGit(['commit', '--no-gpg-sign', '-m', 'inner seed'], { cwd: upstream });

  const parent = path.join(workRoot, 'parent');
  await initRepo(parent);
  await fs.writeFile(path.join(parent, 'root.txt'), 'root\n');
  await runGit(['add', 'root.txt'], { cwd: parent });
  await runGit(['commit', '--no-gpg-sign', '-m', 'parent seed'], { cwd: parent });
  await runGit(
    ['-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor/lib'],
    { cwd: parent },
  );
  await runGit(['commit', '--no-gpg-sign', '-m', 'add submodule'], { cwd: parent });
  const sub = path.join(parent, 'vendor', 'lib');
  await configureRepo(sub);
  return { parent, sub };
}

beforeEach(async () => {
  workRoot = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'xdt-review-submodule-'));
  parentPath = '';
});

afterEach(async () => {
  await fs.rm(workRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('readReviewSubmoduleIdentity (#2463)', () => {
  it('binds inner dirty content: swapping one internal edit for another changes the manifest', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const inner = path.join(sub, 'inner.txt');

    // 内部改动 A:同长度字节,父仓 porcelain 只有一个 dirty 布尔位可看。
    await fs.writeFile(inner, 'inner-vA\n');
    const withEditA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    // 内部改动 B:同尺寸另一份 —— #2463 的攻击形态。
    await fs.writeFile(inner, 'inner-vB\n');
    const withEditB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(withEditA.identities).toHaveLength(1);
    expect(withEditA.hashedContent).toBe(true);
    expect(withEditB.identities).not.toEqual(withEditA.identities);
  });

  it('binds the inner staged identity: index blob swap with restored worktree changes the manifest', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const inner = path.join(sub, 'inner.txt');

    await fs.writeFile(inner, 'inner-vA\n');
    await runGit(['add', 'inner.txt'], { cwd: sub });
    const stagedA = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    // 换 index blob 后把工作树字节还原:工作树哈希看不出差异,靠 staged 身份。
    await fs.writeFile(inner, 'inner-vB\n');
    await runGit(['add', 'inner.txt'], { cwd: sub });
    await fs.writeFile(inner, 'inner-vA\n');
    const stagedB = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(stagedB.identities).not.toEqual(stagedA.identities);
  });

  it('keeps a clean submodule manifest stable and records gitlink + inner HEAD', async () => {
    const { parent } = await setupParentWithSubmodule();
    parentPath = parent;

    const first = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    const second = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(second).toEqual(first);
    const identity = first.identities[0];
    expect(identity.path).toBe('vendor/lib');
    expect(identity.indexRecord).toMatch(/^160000 0 [0-9a-f]{40,64}$/);
    expect(identity.headRecord).toMatch(/^160000 commit [0-9a-f]{40,64}$/);
    expect(identity.subHead).toMatch(/^[0-9a-f]{40,64}$/);
    expect(identity.stagedIdentity).toEqual([]);
    expect(identity.dirtyContentFingerprint).toBeNull();
    expect(first.hashedContent).toBe(false);
  });

  it('changes the manifest when the inner checkout moves to another commit', async () => {
    const { parent, sub } = await setupParentWithSubmodule();
    parentPath = parent;
    const before = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    await fs.writeFile(path.join(sub, 'inner.txt'), 'inner-v2\n');
    await runGit(['commit', '--no-gpg-sign', '-am', 'inner v2'], { cwd: sub });
    const after = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);

    expect(after.identities[0].subHead).not.toBe(before.identities[0].subHead);
    // 父仓 gitlink 记录(index / HEAD tree)不动 —— 变化只发生在子仓内部。
    expect(after.identities[0].indexRecord).toBe(before.identities[0].indexRecord);
  });

  it('records an uninitialized submodule without touching inner state', async () => {
    const { parent } = await setupParentWithSubmodule();
    parentPath = parent;
    // 模拟未初始化:清掉子仓工作区,只留空目录(gitlink 仍在 index/HEAD)。
    await runGit(['submodule', 'deinit', '-f', 'vendor/lib'], { cwd: parent });

    const result = await readReviewSubmoduleIdentity(parentPath, ['vendor/lib']);
    expect(result.identities[0].subHead).toBe('uninitialized');
    expect(result.identities[0].indexRecord).toMatch(/^160000 0 [0-9a-f]{40,64}$/);
    expect(result.hashedContent).toBe(false);
  });

  it('fails closed when the parent repository cannot be read', async () => {
    await expect(
      readReviewSubmoduleIdentity(path.join(workRoot, 'no-such-repo'), ['vendor/lib']),
    ).rejects.toThrow();
  });
});
