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
 *  - 代码围栏与行内代码里的内容先剥离 —— 讨论/演示工具调用语法本身不算泄漏;
 *  - 标记形状要求 `name="..."` 且以 `>` 收尾,name 不含换行且有界。
 *
 * 判定命中与否之外不携带任何正文内容,调用方记日志时同样不应记录正文。
 */

/**
 * 成对的围栏代码块:反引号或波浪线围栏,3 个及以上(CommonMark 允许更长的开栏,
 * 如 ```` 包住含 ``` 的内容)。开栏与闭栏都锚定在行首(允许 0-3 空格缩进,
 * CommonMark 语义)—— 段落中间的行内 ``` / ~~~ 不是围栏,不锚定会把它误作
 * 未闭合围栏吞掉其后的真实泄漏(Greptile review)。闭栏用反向引用要求与开栏
 * 同字符且不短于开栏(更长的闭栏由后随字符类吸收);更短的内层围栏不会提前
 * 闭合外层;未闭合的围栏(正文被截断)吞到结尾。
 */
const FENCED_CODE_RE = /(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?(?:\n[ \t]{0,3}\1[`~]*[ \t]*(?=\n|$)|$)/g;

/**
 * 剥离段落内的 inline code span(CommonMark 语义,对齐
 * packages/maker-shared/src/mathMarkdown.ts 的实现):开 backtick 运行与
 * **等长**闭合运行配对,长度不等不闭合;span 内容允许换行 —— 单行正则会把
 * 「多行合法 code span 里演示的标记」留给检测器造成误报(Codex review)。
 * 无闭合的 backtick 运行按字面量保留。按空行分段处理:CommonMark 的 code
 * span 不跨段落,空行屏障避免两段各自的孤立 backtick 把中间真实泄漏吞掉。
 */
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
  const text = stripInlineCodeSpans(stripIndentedCodeBlocks(rawText.replace(FENCED_CODE_RE, '')));
  const invoke = INVOKE_MARKER_RE.exec(text);
  if (!invoke) return null;
  const afterInvoke = text.slice(invoke.index + invoke[0].length);
  if (!PARAMETER_MARKER_RE.test(afterInvoke)) return null;
  return { category: 'invoke-with-parameter' };
}
