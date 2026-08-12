/**
 * Review 新鲜度的 staged index 身份读取(#2460)。
 *
 * 内容指纹只哈希**工作树文件**;staged 内容存放在 Git index 中。同一路径同时
 * 存在 staged 与 unstaged 的无正文 diff(binary / large-text / too-large /
 * capped)时,把 index blob 换成同尺寸的另一份、再把工作树字节还原:porcelain
 * status、空 patch 元数据与工作树内容指纹全部不变——两道 freshness gate 都会
 * 放行,review 结论针对的却是已经过期的 staged 证据。
 *
 * 这里只绑定 Git 已经算好的**对象身份** `(path, mode, stage, oid)`,不读 blob
 * 字节:oid 天然稳定(同内容同 oid,重复 git add 不误伤),也不引入新的字节
 * 读取面。staged 删除没有 index 条目——「缺席」本身就是身份,记为 absent 标记,
 * 与「换了另一份 blob」同样参与指纹。unmerged 条目的 stage 1/2/3 各自成行,
 * 完整可表达。git 命令失败时抛错 fail closed(与 Git 证据读取失败同语义,由
 * 调用方中止 Review)。
 */

import { runGit } from './gitRunner.js';

/** `:(top,literal)` 前缀:按仓库根字面匹配,不展开 glob。 */
function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

/**
 * 读取一组路径的 staged index 身份记录,稳定排序返回。
 *
 * 返回记录形如 `<mode> <stage> <oid>\t<path>`(存在于 index)或
 * `absent\t<path>`(index 无该条目,如 staged 删除)。记录组与输入顺序无关,
 * 调用方把整组并入 workspace fingerprint 即完成绑定。
 */
export async function readStagedIndexIdentity(
  repoRoot: string,
  rawPaths: readonly string[],
): Promise<string[]> {
  const paths = [...new Set(rawPaths)]
    .filter((p) => p.length > 0 && !p.includes('\n') && !p.includes('\r'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paths.length === 0) return [];

  const { stdout } = await runGit(
    ['ls-files', '--stage', '-z', '--', ...paths.map(literalPathspec)],
    { cwd: repoRoot, maxStdoutBytes: Math.max(1024 * 1024, paths.length * 512) },
  );

  // 记录格式:"<mode> <oid> <stage>\t<path>",NUL 分隔。
  const entriesByPath = new Map<string, string[]>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).trim().split(/\s+/);
    const filePath = record.slice(tab + 1);
    if (!mode || !oid || !stage || !filePath) continue;
    const rows = entriesByPath.get(filePath) ?? [];
    rows.push(`${mode} ${stage} ${oid}\t${filePath}`);
    entriesByPath.set(filePath, rows);
  }

  const records: string[] = [];
  for (const p of paths) {
    const rows = entriesByPath.get(p);
    if (rows && rows.length > 0) {
      // unmerged 时同一路径有 stage 1/2/3 多行;行内排序保证稳定。
      records.push(...rows.sort());
    } else {
      records.push(`absent\t${p}`);
    }
  }
  return records;
}
