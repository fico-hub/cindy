/**
 * feishu/cardSegments.ts
 * ---------------------------------------------------------------------------
 * 长文本按飞书卡片大小上限分段(纯逻辑,供 streamingText 接线;issue #924)。
 *
 * 背景:飞书 interactive card 的内容体积有硬上限(整卡 JSON ~30KB)。超长回复
 * 原先在 finalize patch 时被 API 拒收,catch 只 log.warn —— 卡片永远停在最后
 * 一个流式中间帧,用户零提示地丢失整条回复。
 *
 * 语义:
 *   - splitMarkdownForCards:按行累积字节数切段,段间保持 markdown fence 平衡
 *     (段尾在代码块内则补 ``` 关闭、下一段开头重开),单行超限时按码点硬切,
 *     绝不切开代理对。
 *   - capMarkdownTailBytes:流式中间帧的截尾展示 —— 保留**尾部**(直播视图里
 *     最新内容最有信息量),头部替换为提示;被丢弃的头部若含奇数个 fence 标记,
 *     在尾部前补开 ``` 以保持渲染正确。
 *
 * 字节口径:UTF-8(Buffer.byteLength)。上限给 24_000,为卡片 JSON 脚手架、
 * 分段标头与转义留出余量。
 */

/** 单张卡片正文的安全字节预算(整卡 JSON 上限 ~30KB,留脚手架余量)。 */
export const FEISHU_CARD_TEXT_MAX_BYTES = 24_000;

/** 该行是否为 markdown fence 标记行(``` 或 ~~~ 开头,忽略前导空格)。 */
function isFenceLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('```') || t.startsWith('~~~');
}

/** 统计文本中 fence 标记行数(奇数 = 结尾处于未关闭代码块内)。 */
function countFenceLines(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (isFenceLine(line)) n += 1;
  return n;
}

/** 按码点把超长单行硬切成若干 ≤maxBytes 的片(绝不切开代理对)。 */
function hardSplitLine(line: string, maxBytes: number): string[] {
  const out: string[] = [];
  let piece = '';
  let pieceBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (pieceBytes + chBytes > maxBytes && piece) {
      out.push(piece);
      piece = '';
      pieceBytes = 0;
    }
    piece += ch;
    pieceBytes += chBytes;
  }
  if (piece) out.push(piece);
  return out;
}

/**
 * 把 markdown 文本切成若干段,每段 UTF-8 字节数 ≤ maxBytes。
 * 优先按行边界切;段尾若处于未关闭 fence 内,补 ``` 关闭并在下一段开头重开,
 * 让每段独立渲染都成立。文本本身不超限时原样返回单段。
 */
export function splitMarkdownForCards(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  // fence 修补每段最多引入 8 字节("```\n" ×2),预算里预留。
  const budget = Math.max(64, maxBytes - 8);
  const segments: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  const pushLine = (line: string): void => {
    // +1 = 行间换行符。
    const lineBytes = Buffer.byteLength(line, 'utf8') + (current.length > 0 ? 1 : 0);
    if (currentBytes + lineBytes > budget && current.length > 0) {
      segments.push(current.join('\n'));
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += Buffer.byteLength(line, 'utf8') + (current.length > 1 ? 1 : 0);
  };
  for (const line of text.split('\n')) {
    if (Buffer.byteLength(line, 'utf8') > budget) {
      for (const piece of hardSplitLine(line, budget)) pushLine(piece);
    } else {
      pushLine(line);
    }
  }
  if (current.length > 0) segments.push(current.join('\n'));

  // fence 平衡修补:跨段的代码块在段尾关闭、下一段开头重开。
  let openFromPrev = false;
  return segments.map((seg) => {
    let fixed = seg;
    if (openFromPrev) fixed = '```\n' + fixed;
    const inFenceAtEnd = countFenceLines(fixed) % 2 === 1;
    if (inFenceAtEnd) fixed = fixed + '\n```';
    openFromPrev = inFenceAtEnd;
    return fixed;
  });
}

/**
 * 流式中间帧的截尾展示:超限时保留尾部、头部替换为 `notice`。
 * 被丢弃头部含奇数 fence 标记时在尾部前补开 ```(尾部正处于代码块内)。
 */
export function capMarkdownTailBytes(text: string, maxBytes: number, notice: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const budget = Math.max(64, maxBytes - Buffer.byteLength(notice, 'utf8') - 8);
  // 从尾部往前按行累积;单行超预算的极端情况退化为按码点截尾。
  const lines = text.split('\n');
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(lines[i], 'utf8') + (kept.length > 0 ? 1 : 0);
    if (bytes + lineBytes > budget) break;
    kept.unshift(lines[i]);
    bytes += lineBytes;
  }
  let tail: string;
  if (kept.length > 0) {
    tail = kept.join('\n');
  } else {
    // 尾行本身超预算:按码点从尾部截。
    const chars = [...text];
    let acc = '';
    let accBytes = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
      const chBytes = Buffer.byteLength(chars[i], 'utf8');
      if (accBytes + chBytes > budget) break;
      acc = chars[i] + acc;
      accBytes += chBytes;
    }
    tail = acc;
  }
  const dropped = text.slice(0, text.length - tail.length);
  const reopenFence = countFenceLines(dropped) % 2 === 1 ? '```\n' : '';
  return notice + reopenFence + tail;
}
