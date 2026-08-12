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
import {
  readStagedIndexIdentity,
  splitIntoBatches,
  type IndexIdentityBatchLimits,
} from '../git-review/indexIdentityReader.js';
import { fingerprintReviewCappedWorkspaceFiles } from './reviewCappedWorkspaceFingerprint.js';

/** 嵌套 submodule 的递归深度封顶;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_RECURSION_DEPTH = 5;
/** 单个子仓 dirty 条目上限;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_DIRTY_ENTRIES = 10_000;
/**
 * 整次 manifest 构建(全部子仓 + 嵌套递归)**共享**的内容哈希预算。上限与
 * capped 指纹器单次调用相同,但这里跨子仓累计扣减 —— 否则 N 个大型 dirty
 * 子仓各自重置 512MB 额度,快照总读取量没有上限。耗尽 fail closed。
 */
const MAX_MANIFEST_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_CONTENT_PATHS = 10_000;

interface ManifestContentBudget {
  remainingBytes: number;
  remainingPaths: number;
}

export class ReviewSubmoduleIdentityError extends Error {}

/** 单个 submodule 的身份 manifest(JSON 可序列化,字段序即声明序,确定性)。 */
export interface ReviewSubmoduleIdentity {
  path: string;
  /**
   * 父仓 index 里的 gitlink 记录(`<mode> <stage> <oid>`);unmerged 时
   * stage 1/2/3 全部并入并稳定排序、逗号连接,缺席记 'absent'。
   */
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
  // unmerged gitlink 在 index 里是 stage 1/2/3 三条记录,全部并入身份并稳定
  // 排序 —— 只留最后一条会让「替换较早 stage 的 OID」逃过新鲜度检查(与
  // readStagedIndexIdentity 的多 stage 表达同一裁决)。
  const indexRows: string[] = [];
  for (const record of stageOut.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== subPath) continue;
    const [mode, oid, stage] = record.slice(0, tab).trim().split(/\s+/);
    if (mode && oid && stage) indexRows.push(`${mode} ${stage} ${oid}`);
  }
  const indexRecord = indexRows.length > 0 ? indexRows.sort().join(',') : 'absent';

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

/**
 * 子仓 index 里 mode 160000 的路径集合(区分嵌套 submodule 与普通文件)。
 * pathspec 与 indexIdentityReader 同规则分批(Windows ~32K 命令行上限),
 * 批间合并集合,语义与单次调用一致。
 */
async function readGitlinkPaths(
  subRoot: string,
  candidates: readonly string[],
  batch?: IndexIdentityBatchLimits,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const gitlinks = new Set<string>();
  for (const group of splitIntoBatches(candidates, batch)) {
    const { stdout } = await runGit(
      ['ls-files', '--stage', '-z', '--', ...group.map(literalPathspec)],
      { cwd: subRoot, maxStdoutBytes: Math.max(1024 * 1024, group.length * 512) },
    );
    for (const record of stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const mode = record.slice(0, tab).trim().split(/\s+/)[0];
      if (mode === '160000') gitlinks.add(record.slice(tab + 1));
    }
  }
  return gitlinks;
}

async function readOneSubmoduleIdentity(
  repoRoot: string,
  subPath: string,
  depth: number,
  budget: ManifestContentBudget,
  batch?: IndexIdentityBatchLimits,
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
  // 「未初始化」只有两种合法形态:工作树目录整个缺席(gitlink 在、目录被清),
  // 或 deinit 后留下的空目录(rev-parse 静默落到父仓 → toplevel 归属不是子仓
  // 自身)。除这两种外的任何读取失败(权限、git 异常、realpath 失败)都必须
  // 向上抛 fail closed —— 把读取错误降级成稳定的 'uninitialized' 身份,会让
  // 不同的内层内容映射到同一 manifest,新鲜度门形同虚设。
  let subEntry;
  try {
    subEntry = await fsPromises.lstat(subRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return uninitialized;
    throw new ReviewSubmoduleIdentityError(
      `Review cannot stat submodule worktree ${subPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!subEntry.isDirectory()) {
    // gitlink 被普通文件 / 符号链接替换(typechange):porcelain 的 sub 字段仍
    // 标 S,statusReader 把它当 submodule 路由到这里;把 rev-parse 的 cwd 指到
    // 普通文件只会 ENOTDIR。这类条目的新鲜度真身就是那份文件字节 —— 交给
    // capped 指纹器绑定内容(同一套路径守卫、敏感过滤与共享预算);符号链接
    // 指向目录等超出表达能力的形态由指纹器 fail closed。
    budget.remainingPaths -= 1;
    if (budget.remainingPaths < 0) {
      throw new ReviewSubmoduleIdentityError(
        `Review submodule manifest exceeds the shared content-path budget of ${MAX_MANIFEST_CONTENT_PATHS}`,
      );
    }
    const typechangeFingerprint = await fingerprintReviewCappedWorkspaceFiles(
      repoRoot,
      [subPath],
      { byteBudget: budget },
    );
    return {
      identity: {
        path: subPath,
        indexRecord,
        headRecord,
        subHead: 'typechange',
        stagedIdentity: [],
        dirtyContentFingerprint: typechangeFingerprint,
        nested: [],
      },
      hashedContent: true,
    };
  }
  const { stdout: toplevelOut } = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: subRoot,
    maxStdoutBytes: 4096,
  });
  const [toplevelReal, subRootReal] = await Promise.all([
    fsRealpath(toplevelOut.trim()),
    fsRealpath(subRoot),
  ]);
  if (toplevelReal !== subRootReal) return uninitialized;
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
    batch,
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

  const stagedIdentity = await readStagedIndexIdentity(subRoot, stagedPaths, batch);
  // 工作树 dirty 普通文件走 capped 指纹器:同一套路径守卫、敏感路径过滤、
  // 字节上限与「哈希期间文件变了就抛 ChangedError」的稳定性语义。目录形态
  // (如 untracked 的内嵌仓库)会被它拒绝 —— 即 fail closed,不静默跳过。
  let dirtyContentFingerprint: string | null = null;
  let hashedContent = false;
  if (worktreePaths.length > 0) {
    // 字节与路径预算都从整次构建的共享额度里扣,不按子仓重置。
    budget.remainingPaths -= worktreePaths.length;
    if (budget.remainingPaths < 0) {
      throw new ReviewSubmoduleIdentityError(
        `Review submodule manifest exceeds the shared content-path budget of ${MAX_MANIFEST_CONTENT_PATHS}`,
      );
    }
    dirtyContentFingerprint = await fingerprintReviewCappedWorkspaceFiles(subRoot, worktreePaths, {
      byteBudget: budget,
    });
    hashedContent = true;
  }

  const nested: ReviewSubmoduleIdentity[] = [];
  for (const nestedPath of nestedPaths) {
    const child = await readOneSubmoduleIdentity(subRoot, nestedPath, depth + 1, budget, batch);
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
  limits?: { maxContentBytes?: number; maxContentPaths?: number; batch?: IndexIdentityBatchLimits },
): Promise<ReviewSubmoduleIdentityResult> {
  // 不做字符过滤:pathspec 经 argv 传递、输出全部走 -z(NUL 分隔、无引号
  // 转义),含 \n / \r 的合法 submodule 路径同样必须绑定身份 —— 静默丢弃
  // 就是绕过口(与 indexIdentityReader 同一裁决)。
  const paths = [...new Set(rawPaths)]
    .filter((p) => p.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const budget: ManifestContentBudget = {
    remainingBytes: limits?.maxContentBytes ?? MAX_MANIFEST_CONTENT_BYTES,
    remainingPaths: limits?.maxContentPaths ?? MAX_MANIFEST_CONTENT_PATHS,
  };
  const identities: ReviewSubmoduleIdentity[] = [];
  let hashedContent = false;
  for (const subPath of paths) {
    const one = await readOneSubmoduleIdentity(repoRoot, subPath, 1, budget, limits?.batch);
    identities.push(one.identity);
    hashedContent = hashedContent || one.hashedContent;
  }
  return { identities, hashedContent };
}
