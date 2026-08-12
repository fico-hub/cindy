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
 * 是缩进代码不是围栏,Codex review)+ 可叠加的列表项标记(`- ` / `1. ` /
 * 嵌套 `- - ` 等 —— 列表项内的围栏示例是合法文档形态,第八、十轮 review)
 * + 3 个及以上同字符
 * 运行;反引号开栏的 info string 不得含反引号(含则整行不是开栏),波浪线
 * 开栏无此限制。捕获组:m[1]=运行前的全部前缀,m[2]=围栏运行,m[3]=info。
 */
// 前缀空白放开由代码按列宽校验:纯空白开栏的缩进上限是「3 列」或「当前列表
// 内容列 + 3」(列表内容列可超过 3,如 `-   Example:` 的续行围栏缩进 4 列,
// 第十三轮 Codex review),正则写死 0-3 会在进入列表上下文逻辑前就拒绝。
const FENCE_OPEN_RE = /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*)(`{3,}|~{3,})(.*)$/;
/** 闭栏行:纯缩进 + 围栏运行 + 尾随空白;缩进上限(按列宽)由开栏的容器边距决定。 */
const FENCE_CLOSE_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;

/**
 * 字符串的列宽(tab 按 CommonMark 展开到下一个 4 的倍数列)。用于容器边距与
 * 缩进比较 —— 只数空格会把 tab 缩进的围栏内容当成零缩进,提前隐式闭栏造成
 * 误报(第十轮 review)。
 */
function widthInColumns(prefix: string): number {
  let col = 0;
  for (const ch of prefix) {
    col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  }
  return col;
}

/** 行首空白的列宽(遇到第一个非空白字符停)。 */
function leadingIndentColumns(line: string): number {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? '';
  return widthInColumns(ws);
}

/**
 * 行首缩进是否**确定**低于 cols 列。行首空白含 tab 时列数有歧义(tab 停靠位
 * 依上下文膨胀,不同实现结论不一,第十三轮 Greptile review 的形态即 tab 展开
 * 4 列 vs 内容列 5)—— fail-open 按「缩进足够」处理:围栏多留在容器里只会
 * 少判,不会把正常示例误报成泄漏。
 */
function indentDefinitelyBelow(line: string, cols: number): boolean {
  const ws = /^[ \t]*/.exec(line)?.[0] ?? '';
  if (ws.includes('\t')) return false;
  return ws.length < cols;
}

/**
 * 剥离围栏代码块 —— 行级状态机替代正则(第五、七轮 review 后正则已不可维护):
 *  - 闭栏与开栏同字符、不短于开栏、除尾随空格外不得有其他内容
 *    (`` ```~~~ `` 混合行不是闭栏);更短的内层围栏不闭合外层;
 *  - 未闭合围栏(正文被截断)吞到输入末尾 —— 输入按容器分段传入
 *    (见 stripBlockStructures),引用里的未闭合围栏只吞到该引用段末尾,
 *    不会把引用外的真实泄漏一并吞掉(Codex review)。
 */
/** 纯列表标记行(不带围栏):用于维护「当前列表项内容列」上下文。 */
const LIST_MARKER_LINE_RE = /^( {0,3}(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})+)/;

function stripFencedBlocks(lines: string[]): string[] {
  const out: string[] = [];
  // maxCloseIndent = 开栏容器边距 + 3(CommonMark:闭栏缩进相对容器至多 3 空格
  // —— 列表项内的闭栏随列表边距整体右移)。contentIndent 仅列表语境的开栏非零:
  // 围栏内容必须缩进到列表项内容列,低于该缩进的非空行意味着列表项(连同其中
  // 未闭合的围栏)已经结束 —— 隐式闭栏并按普通行重新处理,未闭合的列表围栏
  // 不再把列表外的真实泄漏吞到输入末尾(第九轮 Codex review)。顶层围栏
  // contentIndent 为 0,保持「未闭合吞到段末」的既有语义。
  let fence: { char: string; len: number; maxCloseIndent: number; contentIndent: number } | null =
    null;
  // 当前列表项的内容列(0 = 不在列表项上下文)。围栏开在列表项的**续行**上时
  // (- Example: 换行后缩进的 ```xml),开栏前缀只有空白、不含标记 —— 靠这个
  // 跨行上下文把它绑回列表项,低缩进行仍能隐式闭栏(第十二轮 Codex review)。
  // 标记行建立上下文;低于内容列的非空行清除;空行不清(列表项内允许空行)。
  let listContentCol = 0;
  for (const line of lines) {
    if (fence) {
      const c = FENCE_CLOSE_RE.exec(line);
      if (
        c &&
        widthInColumns(c[1]) <= fence.maxCloseIndent &&
        // 列表围栏的闭栏必须保持在列表项内容列上(下界):缩进低于容器边距的
        // 围栏行已经退出列表项,是**新的顶层开栏**而不是内层闭栏 —— 走下方
        // 隐式退出后按普通行重新处理(第十一轮 Codex review)。
        widthInColumns(c[1]) >= fence.contentIndent &&
        c[2][0] === fence.char &&
        c[2].length >= fence.len
      ) {
        fence = null; // 闭栏行本身也剥掉
        continue;
      }
      if (fence.contentIndent > 0 && !/^[ \t]*$/.test(line)) {
        if (indentDefinitelyBelow(line, fence.contentIndent)) {
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
        const prefixCols = widthInColumns(m[1]);
        // 缩进合法性按列宽校验(正则前缀已放开):
        //  - 标记开栏:标记前的纯空白 ≤3 列,或(嵌套列表)≤ 内容列 + 3;
        //  - 纯空白开栏:≤3 列(顶层),或落在列表项续行区间
        //    [内容列, 内容列 + 3](内容列可超过 3,第十三轮 Codex review);
        //  - 更深的缩进是缩进代码,不是围栏,落到下方普通行处理。
        const leadWsCols = widthInColumns(/^[ \t]*/.exec(m[1])?.[0] ?? '');
        const openerValid = isListOpener
          ? leadWsCols <= 3 || (listContentCol > 0 && leadWsCols <= listContentCol + 3)
          : prefixCols <= 3 ||
            (listContentCol > 0 && prefixCols >= listContentCol && prefixCols <= listContentCol + 3);
        if (openerValid) {
          const contentIndent = isListOpener
            ? prefixCols
            : listContentCol > 0 && prefixCols >= listContentCol
            ? listContentCol
            : 0;
          fence = {
            char,
            len: m[2].length,
            maxCloseIndent: prefixCols + 3,
            contentIndent,
          };
          if (isListOpener) listContentCol = prefixCols;
          else if (contentIndent === 0 && prefixCols < listContentCol) listContentCol = 0;
          continue;
        }
      }
    }
    if (!/^[ \t]*$/.test(line)) {
      const lm = LIST_MARKER_LINE_RE.exec(line);
      if (lm) {
        listContentCol = widthInColumns(lm[1]);
      } else if (indentDefinitelyBelow(line, listContentCol)) {
        listContentCol = 0;
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
// 允许可选的列表项标记前缀:`- > ```xml` 是「列表项里嵌引用」的合法组合,
// 只认根级 `>` 会把首行留在引用段外、后续行却按引用处理,容器被撕裂
// (第十六轮 Codex review)。剥前缀时列表标记随 `>` 一起去掉,内层按引用
// 内容递归。
// 前导空白放开由代码按列宽校验(深列表续行上的引用,第二十一轮 Codex
// review:`-   Example:` 内容列 4 时,四空格缩进的 > 行仍是列表项内的引用)。
const BLOCKQUOTE_LINE_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*>/;
const BLOCKQUOTE_MARKER_RE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*> ?/;

/**
 * 按块结构剥离代码容器:先在**当前容器层**剥围栏,再把连续的 blockquote 行
 * 作为子容器摘出、去掉一层 `>` 前缀后递归处理,最后剥当前层的缩进代码块。
 * 容器边界不能先抹平(第七轮 Codex review):引用里未闭合的围栏若被提升到
 * 顶层,会把引用外的真实泄漏一并吞掉 —— 分段处理后它只吞到引用段末尾。
 * 递归深度限 8 层:更深的引用嵌套按原文保留(fail-open 方向是少剥,只可能
 * 多判不会漏判 —— 但标记正则要求裸形态,残留的 `>` 前缀行不会命中 invoke
 * 行首形态之外的内容,误报面可忽略)。
 */
/**
 * CommonMark 原始 HTML 块(渲染端 skipHtml 下整块不展示,块内的协议示例
 * 用户看不到,不算泄漏 —— 第十四轮 Codex review):
 *  - type 1 容器(script / pre / style / textarea):到含闭合标签的行(含)
 *    为止,未闭合吞到段末(渲染端同样整段隐藏);
 *  - type 6(标准块级标签开头,如 <div> / <table>):到空行为止。
 * type 7(任意成对标签独立成行)**刻意不剥**:类 B 泄漏的 `<parameter …>`
 * 行本身就是这种形状,剥掉会把真实泄漏藏进「HTML 块」里致盲检测 —— 这里
 * 取检测优先,代价是「自定义标签块 + 紧随标记」的极端形态可能误报,标准
 * 块级标签已由 type 6 覆盖。
 */
// 前缀空白放开由代码按列宽校验(与围栏开栏同规则,第十六轮 Codex review:
// 内容列超过 3 的列表续行上的 HTML 块也要识别);并允许可选列表标记前缀
// (- <script> 直接开在列表项标记行上,第十七轮 Codex review)。捕获组:
// m[1]=前缀,m[2]=标签名。
const HTML_BLOCK_TYPE1_OPEN_RE =
  /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*)<(script|pre|style|textarea)\b/i;
const HTML_BLOCK_TYPE6_RE =
  /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*)<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t/>]|$)/i;

/** 行首(允许列表标记前缀)开启且同一行未闭合的 HTML 注释。 */
const HTML_COMMENT_OPEN_RE = /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]{1,4})*)<!--/;

function stripHtmlBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let closeTag: RegExp | null = null;
  let inType6 = false;
  let inComment = false;
  // blockIndent = 当前 HTML 块所属列表项的内容列(0 = 顶层)。开在列表续行上
  // 的未闭合 HTML 块随列表项结束而终止(与围栏状态机同规则,第十五轮 Codex
  // review):低于内容列的非空行按普通行重新处理,块外的真实泄漏不被吞掉。
  let blockIndent = 0;
  let listContentCol = 0;
  for (const line of lines) {
    const blank = /^[ \t]*$/.test(line);
    if (inComment) {
      if (blockIndent > 0 && !blank && indentDefinitelyBelow(line, blockIndent)) {
        inComment = false; // 注释随列表项终止,该行按普通行重新处理。
      } else {
        if (line.includes('-->')) inComment = false;
        continue;
      }
    } else if (closeTag) {
      if (blockIndent > 0 && !blank && indentDefinitelyBelow(line, blockIndent)) {
        closeTag = null; // 列表项结束,块随容器终止;该行落下去按普通行处理。
      } else {
        if (closeTag.test(line)) closeTag = null;
        continue;
      }
    } else if (inType6) {
      if (blank) {
        inType6 = false;
        out.push(line);
        continue;
      }
      if (blockIndent > 0 && indentDefinitelyBelow(line, blockIndent)) {
        inType6 = false; // 同上:随列表项终止,该行重新处理。
      } else {
        continue;
      }
    }
    // 开栏缩进合法性与围栏同规则:标记开栏的前导空白 ≤3 列或(嵌套)
    // ≤ 内容列 + 3;纯空白开栏 ≤3 列或落在列表续行区间 [内容列, 内容列+3];
    // 更深的缩进是缩进代码,不是 HTML 块。
    const t1 = HTML_BLOCK_TYPE1_OPEN_RE.exec(line);
    const t6 = t1 ? null : HTML_BLOCK_TYPE6_RE.exec(line);
    const opener = t1 ?? t6;
    if (opener) {
      const prefix = opener[1] ?? '';
      const isListOpener = /\S/.test(prefix);
      const prefixCols = widthInColumns(prefix);
      const leadWsCols = widthInColumns(/^[ \t]*/.exec(prefix)?.[0] ?? '');
      const ok = isListOpener
        ? leadWsCols <= 3 || (listContentCol > 0 && leadWsCols <= listContentCol + 3)
        : prefixCols <= 3 ||
          (listContentCol > 0 && prefixCols >= listContentCol && prefixCols <= listContentCol + 3);
      if (ok) {
        blockIndent = isListOpener
          ? prefixCols
          : listContentCol > 0 && !indentDefinitelyBelow(line, listContentCol)
          ? listContentCol
          : 0;
        if (isListOpener) listContentCol = prefixCols;
        if (t1) {
          const close = new RegExp(`</${t1[2]}>`, 'i');
          if (!close.test(line)) closeTag = close;
        } else {
          inType6 = true;
        }
        continue;
      }
    }
    const cm = HTML_COMMENT_OPEN_RE.exec(line);
    if (cm && !line.slice(cm[0].length).includes('-->')) {
      // 未闭合的行首注释按块处理:容器边界与 type 1/6 同规则 —— 开在列表项内
      // 时随列表项结束终止,不再从 <!-- 一路吞到全文末尾(第十九轮 Codex
      // review);同一行内闭合的注释留给后续闭合式注释正则。开栏缩进合法性
      // 同样按 type 1/6 的规则校验:缩进代码块里的 <!-- 是展示的代码,不是
      // 注释开栏(第二十轮 Codex review),不合法时该行留给缩进代码剥离。
      const prefix = cm[1] ?? '';
      const isListOpener = /\S/.test(prefix);
      const prefixCols = widthInColumns(prefix);
      const leadWsCols = widthInColumns(/^[ \t]*/.exec(prefix)?.[0] ?? '');
      const ok = isListOpener
        ? leadWsCols <= 3 || (listContentCol > 0 && leadWsCols <= listContentCol + 3)
        : prefixCols <= 3 ||
          (listContentCol > 0 && prefixCols >= listContentCol && prefixCols <= listContentCol + 3);
      if (ok) {
        blockIndent = isListOpener
          ? prefixCols
          : listContentCol > 0 && !indentDefinitelyBelow(line, listContentCol)
          ? listContentCol
          : 0;
        if (isListOpener) listContentCol = prefixCols;
        inComment = true;
        continue;
      }
    }
    if (!blank) {
      const lm = LIST_MARKER_LINE_RE.exec(line);
      if (lm) listContentCol = widthInColumns(lm[1]);
      else if (indentDefinitelyBelow(line, listContentCol)) listContentCol = 0;
    }
    out.push(line);
  }
  return out;
}

function stripBlockStructures(text: string, depth = 0): string {
  // 顺序:围栏最先(围栏里的 <script> / <div> 是代码内容),HTML 块其次,
  // 随后引用容器与缩进代码。
  const afterFences = stripHtmlBlocks(stripFencedBlocks(text.split('\n')));
  const out: string[] = [];
  let quoteRun: string[] | null = null;
  // 引用行的前导空白按列宽校验(≤3 列,或列表续行区间上限 内容列+3):
  // 深于该区间的 > 行是缩进代码不是引用。
  let listContentCol = 0;
  const flushQuote = (): void => {
    if (!quoteRun) return;
    const inner = quoteRun.map((l) => l.replace(BLOCKQUOTE_MARKER_RE, '')).join('\n');
    out.push(depth < 8 ? stripBlockStructures(inner, depth + 1) : inner);
    quoteRun = null;
  };
  for (const line of afterFences) {
    const leadWsCols = leadingIndentColumns(line);
    const quoteIndentOk =
      leadWsCols <= 3 || (listContentCol > 0 && leadWsCols <= listContentCol + 3);
    if (quoteIndentOk && BLOCKQUOTE_LINE_RE.test(line)) {
      (quoteRun ??= []).push(line);
    } else {
      flushQuote();
      if (!/^[ \t]*$/.test(line)) {
        const lm = LIST_MARKER_LINE_RE.exec(line);
        if (lm) listContentCol = widthInColumns(lm[1]);
        else if (indentDefinitelyBelow(line, listContentCol)) listContentCol = 0;
      }
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

/**
 * invoke 开标记:类 B 的典型形态缺失前导 `<`,两种都认。刻意转义的示例不算
 * 泄漏(第十一轮 Codex review):`\<invoke`(CommonMark 反斜杠转义)与
 * `&lt;invoke`(HTML 实体)都是作者在散文里演示协议的写法 —— 带 `<` 的分支
 * 要求 `<` 未被反斜杠转义;裸 `invoke` 分支要求前面既不是 `&lt;` 也不是 `<`
 * (后者已由带 `<` 分支处理)。
 */
const INVOKE_MARKER_RE = /(?:(?<!\\)<|(?<!&lt;)(?<![<\\]))invoke\s+name="[^"\n]{1,128}"\s*>/;
/** parameter 开标记(通常保留 `<`,同样允许缺失;转义规则同上)。 */
const PARAMETER_MARKER_RE = /(?:(?<!\\)<|(?<!&lt;)(?<![<\\]))parameter\s+name="[^"\n]{1,128}"\s*>/;

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
/**
 * **闭合式** HTML 注释(跨行也认)。注释里的协议示例用户看不到,不算泄漏
 * (第十二轮 Codex review)。未闭合注释不在这里处理:行首形态由
 * stripHtmlBlocks 按容器边界处理(开在列表/引用里的未闭合注释随容器终止,
 * 不吞容器外正文,第十九轮 Codex review),顶层未闭合在那里吞到段末与渲染
 * 端 skipHtml 一致。在块结构剥离之后应用:围栏内的 `<!--` 是代码内容,已随
 * 围栏剥掉,不会在这里误配对。
 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * `<` 的数字字符引用(十进制 &#60; / 十六进制 &#x3c;,允许前导零与大小写)。
 * 统一归一成 `&lt;`,由标记正则的实体转义排除分支处理(第十二轮 Codex
 * review:只排除 &lt; 拼写会漏掉数字引用形式的转义示例)。
 */
// 命名引用大小写变体(&LT; / &Lt; 等均为合法 HTML 引用)一并归一(第十六轮
// Codex review:只排除小写拼写会漏掉大写变体的转义示例)。
const LT_CHAR_REF_RE = /&#0{0,6}60;|&#[xX]0{0,6}3[cC];|&lt;/gi;

export function detectLeakedToolCallMarkup(rawText: string): LeakedToolMarkupHit | null {
  if (!rawText || rawText.length < 16) return null;
  const text = stripInlineCodeSpans(
    stripBlockStructures(rawText).replace(HTML_COMMENT_RE, '').replace(LT_CHAR_REF_RE, '&lt;'),
  );
  const invoke = INVOKE_MARKER_RE.exec(text);
  if (!invoke) return null;
  const afterInvoke = text.slice(invoke.index + invoke[0].length);
  if (!PARAMETER_MARKER_RE.test(afterInvoke)) return null;
  return { category: 'invoke-with-parameter' };
}
