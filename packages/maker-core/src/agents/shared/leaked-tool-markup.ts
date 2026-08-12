/**
 * 泄漏工具调用标记检测(#2518 类 B)。
 *
 * 模型偶发把工具调用块写坏(开标签的 `<` 与外层调用标签一起丢失),SDK 解析器
 * 从未进入工具调用状态,损坏的标记连同参数正文被当作**普通 assistant 文本**
 * 输出 —— 回合静默按成功收口,工具实际没执行,用户无从分辨「做完了」和
 * 「压根没跑」。
 *
 * 这里只做**窄范围**的协议标记检测,供各 agent 的收口分类共用(标记语法集中
 * 定义,不在各 translator 里复制正则):
 *
 *  - 必须同时命中「invoke 开标记(允许缺失前导 `<`)」与其**之后**的
 *    「parameter 开标记」—— 单独出现 invoke / parameter 词汇、普通英文讨论
 *    不构成命中;
 *  - 代码围栏、缩进代码块、blockquote 内的代码、行内 code span 先按
 *    CommonMark 块结构剥离 —— 讨论/演示工具调用语法本身不算泄漏;
 *  - 标记形状要求 `name="..."` 且以 `>` 收尾,name 不含换行且有界。
 *
 * 误报与漏检的代价不对称:误报会把正常回合打成终态错误并触发自动续跑
 * (用户可见的伤害),漏检只是退化为本检测存在之前的现状(按成功收口)。
 * 因此剥离逻辑取向 fail-open:拿不准的形态宁可少剥少判。
 *
 * 判定命中与否之外不携带任何正文内容,调用方记日志时同样不应记录正文。
 */

/**
 * 围栏开栏(行级判定,CommonMark 语义):行首 0-3 个**空格**缩进(tab 缩进的
 * 是缩进代码不是围栏,Codex review)+ 可选的列表项标记(`- ` / `1. ` 等 ——
 * 列表项内的围栏示例是合法文档形态,第八轮 Codex review)+ 3 个及以上同字符
 * 运行;反引号开栏的 info string 不得含反引号(含则整行不是开栏),波浪线
 * 开栏无此限制。捕获组:m[1]=运行前的全部前缀,m[2]=围栏运行,m[3]=info。
 */
const FENCE_OPEN_RE = /^( {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})?)(`{3,}|~{3,})(.*)$/;
/** 闭栏行:纯缩进 + 围栏运行 + 尾随空白;缩进上限由开栏的容器边距决定。 */
const FENCE_CLOSE_RE = /^( *)(`{3,}|~{3,})[ \t]*$/;

/**
 * 剥离围栏代码块 —— 行级状态机替代正则(第五、七轮 review 后正则已不可维护):
 *  - 闭栏与开栏同字符、不短于开栏、除尾随空格外不得有其他内容
 *    (`` ```~~~ `` 混合行不是闭栏);更短的内层围栏不闭合外层;
 *  - 未闭合围栏(正文被截断)吞到输入末尾 —— 输入按容器分段传入
 *    (见 stripBlockStructures),引用里的未闭合围栏只吞到该引用段末尾,
 *    不会把引用外的真实泄漏一并吞掉(Codex review)。
 */
function stripFencedBlocks(lines: string[]): string[] {
  const out: string[] = [];
  // maxCloseIndent = 开栏容器边距 + 3(CommonMark:闭栏缩进相对容器至多 3 空格
  // —— 列表项内的闭栏随列表边距整体右移)。contentIndent 仅列表开栏时非零:
  // 围栏内容必须缩进到列表项内容列,低于该缩进的非空行意味着列表项(连同其中
  // 未闭合的围栏)已经结束 —— 隐式闭栏并按普通行重新处理,未闭合的列表围栏
  // 不再把列表外的真实泄漏吞到输入末尾(第九轮 Codex review)。顶层围栏
  // contentIndent 为 0,保持「未闭合吞到段末」的既有语义。
  let fence: { char: string; len: number; maxCloseIndent: number; contentIndent: number } | null =
    null;
  for (const line of lines) {
    if (fence) {
      const c = FENCE_CLOSE_RE.exec(line);
      if (
        c &&
        c[1].length <= fence.maxCloseIndent &&
        c[2][0] === fence.char &&
        c[2].length >= fence.len
      ) {
        fence = null; // 闭栏行本身也剥掉
        continue;
      }
      if (fence.contentIndent > 0 && !/^[ \t]*$/.test(line)) {
        const indent = /^ */.exec(line)?.[0].length ?? 0;
        if (indent < fence.contentIndent) {
          fence = null; // 隐式闭栏:该行不属于列表项,落下去按普通行处理。
        } else {
          continue;
        }
      } else {
        continue; // 围栏内容整行剥掉(块内空行不终结围栏)。
      }
    }
    const m = FENCE_OPEN_RE.exec(line);
    if (m) {
      const char = m[2][0];
      const info = m[3] ?? '';
      const validOpen = char === '~' || !info.includes('`');
      if (validOpen) {
        const isListOpener = /\S/.test(m[1]);
        fence = {
          char,
          len: m[2].length,
          maxCloseIndent: m[1].length + 3,
          contentIndent: isListOpener ? m[1].length : 0,
        };
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * 剥离 CommonMark 缩进代码块(4 空格或 tab 起始的行)。规则两条,都来自
 * CommonMark:缩进块**不能打断段落**(紧跟非空行的缩进行是段落的惰性延续,
 * 不算代码,保留 —— 顺带保住「真实泄漏恰好缩进在段落中间」的检出);块内
 * 空行不终结块。合法文档回复用缩进块演示标记语法时不应误报(Codex review)。
 */
function stripIndentedCodeBlocks(text: string): string {
  if (!/^(?: {4}|\t)/m.test(text)) return text;
  const out: string[] = [];
  let prevBlank = true; // 文首视同空行:开头的缩进行就是代码块。
  let inCode = false;
  for (const line of text.split('\n')) {
    const blank = /^[ \t]*$/.test(line);
    if (blank) {
      out.push(line);
      prevBlank = true;
      continue; // 空行不改变 inCode:块内空行仍属于块。
    }
    if (/^(?: {4}|\t)/.test(line) && (prevBlank || inCode)) {
      inCode = true;
      continue;
    }
    inCode = false;
    prevBlank = false;
    out.push(line);
  }
  return out.join('\n');
}

/** blockquote 行(`>` 前至多 3 个空格;`>` 后空格可选,CommonMark 语义)。 */
const BLOCKQUOTE_LINE_RE = /^ {0,3}>/;
const BLOCKQUOTE_MARKER_RE = /^ {0,3}> ?/;

/**
 * 按块结构剥离代码容器:先在**当前容器层**剥围栏,再把连续的 blockquote 行
 * 作为子容器摘出、去掉一层 `>` 前缀后递归处理,最后剥当前层的缩进代码块。
 * 容器边界不能先抹平(第七轮 Codex review):引用里未闭合的围栏若被提升到
 * 顶层,会把引用外的真实泄漏一并吞掉 —— 分段处理后它只吞到引用段末尾。
 * 递归深度限 8 层:更深的引用嵌套按原文保留(fail-open 方向是少剥,只可能
 * 多判不会漏判 —— 但标记正则要求裸形态,残留的 `>` 前缀行不会命中 invoke
 * 行首形态之外的内容,误报面可忽略)。
 */
function stripBlockStructures(text: string, depth = 0): string {
  const afterFences = stripFencedBlocks(text.split('\n'));
  const out: string[] = [];
  let quoteRun: string[] | null = null;
  const flushQuote = (): void => {
    if (!quoteRun) return;
    const inner = quoteRun.map((l) => l.replace(BLOCKQUOTE_MARKER_RE, '')).join('\n');
    out.push(depth < 8 ? stripBlockStructures(inner, depth + 1) : inner);
    quoteRun = null;
  };
  for (const line of afterFences) {
    if (BLOCKQUOTE_LINE_RE.test(line)) {
      (quoteRun ??= []).push(line);
    } else {
      flushQuote();
      out.push(line);
    }
  }
  flushQuote();
  return stripIndentedCodeBlocks(out.join('\n'));
}

/**
 * 剥离段落内的 inline code span(CommonMark 语义,对齐
 * packages/maker-shared/src/mathMarkdown.ts 的实现):开 backtick 运行与
 * **等长**闭合运行配对,长度不等不闭合;span 内容允许换行 —— 单行正则会把
 * 「多行合法 code span 里演示的标记」留给检测器造成误报(Codex review)。
 * 无闭合的 backtick 运行按字面量保留。按空行分段处理:CommonMark 的 code
 * span 不跨段落,空行屏障避免两段各自的孤立 backtick 把中间真实泄漏吞掉。
 */
function stripInlineCodeSpans(text: string): string {
  if (!text.includes('`')) return text;
  return text
    .split(/\n[ \t]*\n/)
    .map(stripInlineCodeSpansInParagraph)
    .join('\n\n');
}

function stripInlineCodeSpansInParagraph(segment: string): string {
  if (!segment.includes('`')) return segment;
  let out = '';
  let cursor = 0;
  while (cursor < segment.length) {
    const tick = segment.indexOf('`', cursor);
    if (tick === -1) {
      out += segment.slice(cursor);
      break;
    }
    let openEnd = tick;
    while (openEnd < segment.length && segment[openEnd] === '`') openEnd += 1;
    const runLength = openEnd - tick;
    // 找等长闭合运行:逐个 backtick 运行推进,线性复杂度。
    let closeStart = -1;
    let probe = openEnd;
    while (probe < segment.length) {
      const t = segment.indexOf('`', probe);
      if (t === -1) break;
      let e = t;
      while (e < segment.length && segment[e] === '`') e += 1;
      if (e - t === runLength) {
        closeStart = t;
        break;
      }
      probe = e;
    }
    if (closeStart === -1) {
      // 无闭合:backtick 运行是字面量,保留后继续扫其后正文。
      out += segment.slice(cursor, openEnd);
      cursor = openEnd;
    } else {
      out += segment.slice(cursor, tick);
      cursor = closeStart + runLength;
    }
  }
  return out;
}

/** invoke 开标记:类 B 的典型形态缺失前导 `<`,两种都认。 */
const INVOKE_MARKER_RE = /<?invoke\s+name="[^"\n]{1,128}"\s*>/;
/** parameter 开标记(通常保留 `<`,同样允许缺失)。 */
const PARAMETER_MARKER_RE = /<?parameter\s+name="[^"\n]{1,128}"\s*>/;

export interface LeakedToolMarkupHit {
  /** 命中类别,进结构化日志用;当前只有一类。 */
  category: 'invoke-with-parameter';
}

/**
 * 检测 assistant 正文中泄漏的工具调用标记。返回 null = 未命中。
 *
 * 调用方应只对「最后一次结构化 tool_use 之后」的正文使用本判定(零 tool 回合
 * 即全文)—— 已正常执行过工具的那段正文里出现类似文本属于讨论语境,不应触发;
 * 之后再出现的泄漏标记(最后一步调用写坏成纯文本)仍需捕获。
 */
export function detectLeakedToolCallMarkup(rawText: string): LeakedToolMarkupHit | null {
  if (!rawText || rawText.length < 16) return null;
  const text = stripInlineCodeSpans(stripBlockStructures(rawText));
  const invoke = INVOKE_MARKER_RE.exec(text);
  if (!invoke) return null;
  const afterInvoke = text.slice(invoke.index + invoke[0].length);
  if (!PARAMETER_MARKER_RE.test(afterInvoke)) return null;
  return { category: 'invoke-with-parameter' };
}
