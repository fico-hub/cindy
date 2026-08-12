/**
 * Review 新鲜度的 submodule 感知身份读取(#2463)。
 *
 * gitlink 是目录,文件指纹器只接受普通文件,所以 submodule 被刻意排除在
 * `workspacePathsWithoutContent` 之外(见 reviewEvidence.ts 的注释)——代价
 * 是「dirty submodule 内部的一份改动换成另一份」时,porcelain 的 `S` 布尔位、
 * 空 patch 元数据与父仓工作树指纹全部不变,两道 freshness gate 都会放行。
 *
 * 这里为每个纳入 Review 的 submodule 读取一份**身份 manifest**:
 *
 *  - 父仓侧:index 里的 gitlink 记录(mode 160000 + oid)与 HEAD tree 里的
 *    gitlink oid —— 绑定「父仓认为子仓应当在哪个 commit」;
 *  - 已初始化子仓:当前 checkout 的 HEAD oid —— 绑定「子仓实际在哪」;
 *  - dirty 子仓:进入子仓读取 —— staged 侧绑定 index 的 (path, mode, stage,
 *    oid)(复用 #2460 的 indexIdentityReader),modified/untracked 工作树侧对
 *    **具体普通文件**做有界内容哈希(复用 capped 指纹器的边界、敏感路径过滤
 *    与稳定性重读);
 *  - 嵌套 submodule 以相同规则递归,深度封顶,超限 fail closed;
 *  - manifest 无法完整读取(git 失败、条目形态超出表达能力)时抛错 fail
 *    closed,与其他 Git 证据读取失败同语义。
 *
 * 只保存 `git submodule status` 一类的 commit oid + dirty 布尔是不够的:子仓
 * HEAD 不变、dirty 文件内容从 A 换成 B 时两者完全相同 —— 必须绑定 dirty
 * tracked/untracked 文件的实际身份,这正是本文件与 #2460 机制共用的原因。
 */

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { runGit } from '../git-review/gitRunner.js';
import { readStagedIndexIdentity } from '../git-review/indexIdentityReader.js';
import { fingerprintReviewCappedWorkspaceFiles } from './reviewCappedWorkspaceFingerprint.js';

/** 嵌套 submodule 的递归深度封顶;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_RECURSION_DEPTH = 5;
/** 单个子仓 dirty 条目上限;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_DIRTY_ENTRIES = 10_000;

export class ReviewSubmoduleIdentityError extends Error {}

/** 单个 submodule 的身份 manifest(JSON 可序列化,字段序即声明序,确定性)。 */
export interface ReviewSubmoduleIdentity {
  path: string;
  /** 父仓 index 里的 gitlink 记录(`<mode> <stage> <oid>`),缺席记 'absent'。 */
  indexRecord: string;
  /** 父仓 HEAD tree 里的 gitlink oid,缺席(如新增未提交)记 'absent'。 */
  headRecord: string;
  /** 子仓状态:未初始化 / HEAD oid;unborn HEAD 记 'unborn'。 */
  subHead: string;
  /** 子仓 dirty staged 侧的 index 身份记录(#2460 同格式);clean 为空数组。 */
  stagedIdentity: string[];
  /** 子仓 dirty 工作树普通文件的有界内容指纹;无 dirty 工作树文件为 null。 */
  dirtyContentFingerprint: string | null;
  /** dirty 的嵌套 submodule,按相同规则递归。 */
  nested: ReviewSubmoduleIdentity[];
}

export interface ReviewSubmoduleIdentityResult {
  identities: ReviewSubmoduleIdentity[];
  /** 是否发生过内层文件内容哈希 —— 调用方据此启用快照稳定性重读窗口。 */
  hashedContent: boolean;
}

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

/** realpath(符号链接归一)——toplevel 归属比较必须在同一坐标系里做。 */
async function fsRealpath(p: string): Promise<string> {
  return fsPromises.realpath(p);
}

/** 父仓 index / HEAD tree 里该路径的 gitlink 记录。 */
async function readParentRecords(
  repoRoot: string,
  subPath: string,
): Promise<{ indexRecord: string; headRecord: string }> {
  const { stdout: stageOut } = await runGit(
    ['ls-files', '--stage', '-z', '--', literalPathspec(subPath)],
    { cwd: repoRoot, maxStdoutBytes: 1024 * 1024 },
  );
  let indexRecord = 'absent';
  for (const record of stageOut.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== subPath) continue;
    const [mode, oid, stage] = record.slice(0, tab).trim().split(/\s+/);
    if (mode && oid && stage) indexRecord = `${mode} ${stage} ${oid}`;
  }

  const { stdout: treeOut } = await runGit(
    ['ls-tree', '-z', 'HEAD', '--', subPath],
    { cwd: repoRoot, maxStdoutBytes: 1024 * 1024, allowedExitCodes: [0, 128] },
  );
  // exit 128 = unborn HEAD 等;当作 tree 无记录处理(absent 本身就是身份)。
  let headRecord = 'absent';
  for (const record of treeOut.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== subPath) continue;
    const [mode, type, oid] = record.slice(0, tab).trim().split(/\s+/);
    if (mode && type && oid) headRecord = `${mode} ${type} ${oid}`;
  }
  return { indexRecord, headRecord };
}

/** 子仓 porcelain v1 条目(--no-renames,单路径记录)。 */
interface SubStatusEntry {
  staged: boolean;
  worktree: boolean;
  untracked: boolean;
  path: string;
}

async function readSubStatus(subRoot: string): Promise<SubStatusEntry[]> {
  const { stdout } = await runGit(
    ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: subRoot, maxStdoutBytes: 16 * 1024 * 1024 },
  );
  const entries: SubStatusEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const entryPath = record.slice(3);
    if (!entryPath) continue;
    if (x === '?' && y === '?') {
      entries.push({ staged: false, worktree: true, untracked: true, path: entryPath });
      continue;
    }
    entries.push({
      staged: x !== ' ' && x !== '?',
      worktree: y !== ' ',
      untracked: false,
      path: entryPath,
    });
  }
  if (entries.length > MAX_SUBMODULE_DIRTY_ENTRIES) {
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind a submodule with more than ${MAX_SUBMODULE_DIRTY_ENTRIES} dirty entries`,
    );
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 子仓 index 里 mode 160000 的路径集合(区分嵌套 submodule 与普通文件)。 */
async function readGitlinkPaths(subRoot: string, candidates: readonly string[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const { stdout } = await runGit(
    ['ls-files', '--stage', '-z', '--', ...candidates.map(literalPathspec)],
    { cwd: subRoot, maxStdoutBytes: Math.max(1024 * 1024, candidates.length * 512) },
  );
  const gitlinks = new Set<string>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const mode = record.slice(0, tab).trim().split(/\s+/)[0];
    if (mode === '160000') gitlinks.add(record.slice(tab + 1));
  }
  return gitlinks;
}

async function readOneSubmoduleIdentity(
  repoRoot: string,
  subPath: string,
  depth: number,
): Promise<{ identity: ReviewSubmoduleIdentity; hashedContent: boolean }> {
  if (depth > MAX_SUBMODULE_RECURSION_DEPTH) {
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind submodules nested deeper than ${MAX_SUBMODULE_RECURSION_DEPTH} levels`,
    );
  }
  const { indexRecord, headRecord } = await readParentRecords(repoRoot, subPath);
  const subRoot = path.join(repoRoot, ...subPath.split('/'));

  // 已初始化判定:目录里能解析出 git toplevel **且 toplevel 就是子仓目录
  // 本身**。只测 rev-parse 成功是不够的 —— deinit 后留下的空目录仍在父仓
  // 工作树里,rev-parse 会静默落到父仓,把父仓 HEAD 错当子仓身份。
  const uninitialized = {
    identity: {
      path: subPath,
      indexRecord,
      headRecord,
      subHead: 'uninitialized',
      stagedIdentity: [],
      dirtyContentFingerprint: null,
      nested: [],
    },
    hashedContent: false,
  };
  let subHead: string;
  try {
    const { stdout: toplevelOut } = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: subRoot,
      maxStdoutBytes: 4096,
    });
    const [toplevelReal, subRootReal] = await Promise.all([
      fsRealpath(toplevelOut.trim()),
      fsRealpath(subRoot),
    ]);
    if (toplevelReal !== subRootReal) return uninitialized;
  } catch {
    return uninitialized;
  }
  try {
    const { stdout } = await runGit(['rev-parse', 'HEAD'], {
      cwd: subRoot,
      maxStdoutBytes: 1024,
    });
    subHead = stdout.trim();
  } catch {
    // toplevel 归属已确认是子仓自身,HEAD 解析不出 = 已初始化的空仓。
    subHead = 'unborn';
  }

  const entries = await readSubStatus(subRoot);
  const gitlinkPaths = await readGitlinkPaths(
    subRoot,
    entries.filter((entry) => !entry.untracked).map((entry) => entry.path),
  );

  const stagedPaths = entries
    .filter((entry) => entry.staged && !gitlinkPaths.has(entry.path))
    .map((entry) => entry.path);
  const worktreePaths = entries
    .filter((entry) => entry.worktree && !gitlinkPaths.has(entry.path))
    .map((entry) => entry.path);
  const nestedPaths = [...new Set(
    entries.filter((entry) => gitlinkPaths.has(entry.path)).map((entry) => entry.path),
  )];

  const stagedIdentity = await readStagedIndexIdentity(subRoot, stagedPaths);
  // 工作树 dirty 普通文件走 capped 指纹器:同一套路径守卫、敏感路径过滤、
  // 字节上限与「哈希期间文件变了就抛 ChangedError」的稳定性语义。目录形态
  // (如 untracked 的内嵌仓库)会被它拒绝 —— 即 fail closed,不静默跳过。
  let dirtyContentFingerprint: string | null = null;
  let hashedContent = false;
  if (worktreePaths.length > 0) {
    dirtyContentFingerprint = await fingerprintReviewCappedWorkspaceFiles(subRoot, worktreePaths);
    hashedContent = true;
  }

  const nested: ReviewSubmoduleIdentity[] = [];
  for (const nestedPath of nestedPaths) {
    const child = await readOneSubmoduleIdentity(subRoot, nestedPath, depth + 1);
    nested.push(child.identity);
    hashedContent = hashedContent || child.hashedContent;
  }

  return {
    identity: {
      path: subPath,
      indexRecord,
      headRecord,
      subHead,
      stagedIdentity,
      dirtyContentFingerprint,
      nested,
    },
    hashedContent,
  };
}

/**
 * 读取一组 submodule 路径的身份 manifest,按路径稳定排序返回。
 *
 * 任何一步 git 读取失败都向上抛(fail closed);调用方把返回的 manifest 并入
 * workspace fingerprint,`hashedContent` 为真时启用快照稳定性重读窗口。
 */
export async function readReviewSubmoduleIdentity(
  repoRoot: string,
  rawPaths: readonly string[],
): Promise<ReviewSubmoduleIdentityResult> {
  const paths = [...new Set(rawPaths)]
    .filter((p) => p.length > 0 && !p.includes('\n') && !p.includes('\r'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const identities: ReviewSubmoduleIdentity[] = [];
  let hashedContent = false;
  for (const subPath of paths) {
    const one = await readOneSubmoduleIdentity(repoRoot, subPath, 1);
    identities.push(one.identity);
    hashedContent = hashedContent || one.hashedContent;
  }
  return { identities, hashedContent };
}
