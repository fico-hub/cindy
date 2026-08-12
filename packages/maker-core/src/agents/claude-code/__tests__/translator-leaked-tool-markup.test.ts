import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import { detectLeakedToolCallMarkup } from '../../shared/leaked-tool-markup.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    uiTextLenAtLastToolUse: 0,
    leakedMarkupBeforeToolUse: null,
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx(tracker: UsageTracker) {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'codex/gpt-5.5',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 272_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

/** issue #2518 实测的类 B 形态:invoke 开标签缺失前导 `<`,parameter 标签完好。 */
const CLASS_B_LEAK =
  'invoke name="Bash">\n<parameter name="command">python -c "import re; print(re.sub(r\'(\\d{4})\', lambda m: m.group(1), \'x\'))"</parameter>\n';

const NON_EMPTY_USAGE = { input_tokens: 1200, output_tokens: 340 };

function pushMessageStart(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>, ctx: ReturnType<typeof createCtx>): void {
  translateSdkMessage(
    {
      type: 'stream_event',
      event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 1200 } } },
    },
    queue,
    ctx,
  );
}

function pushResult(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  resultText?: string,
): void {
  translateSdkMessage(
    {
      type: 'result',
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: NON_EMPTY_USAGE,
      modelUsage: {
        'codex/gpt-5.5': { inputTokens: 1200, outputTokens: 340, costUSD: 0.01, contextWindow: 272_000 },
      },
      ...(resultText !== undefined ? { result: resultText } : {}),
    },
    queue,
    ctx,
  );
}

describe('detectLeakedToolCallMarkup (#2518)', () => {
  it('hits on class B: invoke opener missing "<" followed by a parameter tag', () => {
    expect(detectLeakedToolCallMarkup(CLASS_B_LEAK)).toEqual({ category: 'invoke-with-parameter' });
  });

  it('hits when the invoke opener keeps its "<" but still leaked as text', () => {
    expect(
      detectLeakedToolCallMarkup('<invoke name="Bash">\n<parameter name="command">ls</parameter>'),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit on plain English discussion of invoke/parameter', () => {
    expect(
      detectLeakedToolCallMarkup(
        'You can invoke the function with a parameter name of your choosing; invoke it twice.',
      ),
    ).toBeNull();
  });

  it('does not hit on a lone invoke marker without any parameter tag after it', () => {
    expect(detectLeakedToolCallMarkup('invoke name="Bash"> and nothing else here')).toBeNull();
  });

  it('does not hit on a lone parameter marker without a preceding invoke marker', () => {
    expect(detectLeakedToolCallMarkup('<parameter name="command">ls</parameter> appears alone')).toBeNull();
  });

  it('does not hit when the markers only appear inside fenced code blocks', () => {
    expect(
      detectLeakedToolCallMarkup(
        '工具调用格式示例:\n```xml\ninvoke name="Bash">\n<parameter name="command">ls</parameter>\n```\n以上是语法说明。',
      ),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside inline code spans', () => {
    expect(
      detectLeakedToolCallMarkup(
        '标记形如 `invoke name="Bash">` 与 `<parameter name="command">`,注意顺序。',
      ),
    ).toBeNull();
  });

  it('does not hit on uppercase variants (canonical wire markup is lowercase)', () => {
    expect(
      detectLeakedToolCallMarkup('INVOKE NAME="Bash">\n<PARAMETER NAME="command">ls</PARAMETER>'),
    ).toBeNull();
  });

  it('still hits when an unclosed fence swallows the tail but leak precedes the fence', () => {
    expect(
      detectLeakedToolCallMarkup(`${CLASS_B_LEAK}\n\`\`\`text truncated...`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when the markers only appear inside tilde fences', () => {
    expect(
      detectLeakedToolCallMarkup(`语法示例:\n~~~\n${CLASS_B_LEAK}~~~\n以上是说明。`),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside 4+ backtick fences', () => {
    expect(
      detectLeakedToolCallMarkup(`语法示例:\n\`\`\`\`\n${CLASS_B_LEAK}\`\`\`\`\n以上是说明。`),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside a multiline inline code span', () => {
    // CommonMark 的 code span 内容允许换行:单反引号跨两行包住两个标记,属于
    // 合法文档演示,不是泄漏(Codex review:单行正则会漏剥这种 span 造成误报)。
    expect(
      detectLeakedToolCallMarkup(
        '标记语法是 `invoke name="Bash">\n<parameter name="command">ls</parameter>` 这样的形状。',
      ),
    ).toBeNull();
  });

  it('still hits when stray backticks sit in different paragraphs around a real leak', () => {
    // 空行屏障:code span 不跨段落,两段各自的孤立反引号不能配对成 span 把
    // 中间的真实泄漏吞掉。
    expect(
      detectLeakedToolCallMarkup(
        `先看输出里的 \` 字符。\n\n${CLASS_B_LEAK}\n\n结尾又有一个 \` 字符。`,
      ),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when the markers only appear inside an indented code block', () => {
    // CommonMark 缩进代码块(4 空格):合法文档回复用缩进块演示标记语法。
    const indented = CLASS_B_LEAK.split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n');
    expect(
      detectLeakedToolCallMarkup(`标记语法示例:\n\n${indented}\n\n以上是说明。`),
    ).toBeNull();
  });

  it('still hits when the indented lines lazily continue a paragraph (not a code block)', () => {
    // 缩进块不能打断段落:紧跟非空行的缩进行是段落延续,不剥离 —— 真实泄漏
    // 恰好带缩进出现在段落中间时仍要判。
    const indented = CLASS_B_LEAK.split('\n')
      .map((l) => (l.length > 0 ? `    ${l}` : l))
      .join('\n');
    expect(
      detectLeakedToolCallMarkup(`我现在执行这一步,输出如下\n${indented}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when the markers only appear inside a blockquoted fence', () => {
    // 引用里的围栏(> ```xml)剥掉 blockquote 前缀后按普通围栏处理,块内示例
    // 不命中。
    const quoted = `文档引用:\n> \`\`\`xml\n${CLASS_B_LEAK.split('\n')
      .map((l) => (l.length > 0 ? `> ${l}` : l))
      .join('\n')}> \`\`\`\n以上。`;
    expect(detectLeakedToolCallMarkup(quoted)).toBeNull();
  });

  it('still hits on a bare leak inside a blockquote (no fence)', () => {
    // 引用里的裸泄漏剥掉前缀后仍是裸文本,不丢检出。
    const quoted = CLASS_B_LEAK.split('\n')
      .map((l) => (l.length > 0 ? `> ${l}` : l))
      .join('\n');
    expect(detectLeakedToolCallMarkup(`上一轮输出是:\n${quoted}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('still hits when a tab-indented backtick line precedes the leak (not a fence opener)', () => {
    // CommonMark:tab 缩进的 ``` 行是缩进代码/段落延续,不是围栏开栏 ——
    // 不能被误作未闭合围栏把其后的真实泄漏吞到结尾。
    expect(
      detectLeakedToolCallMarkup(`参考这行输出\n\t\`\`\`\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when a backtick "opener" has backticks in its info string (invalid fence)', () => {
    // CommonMark:反引号开栏的 info string 不得含反引号,含则整行不是开栏。
    expect(
      detectLeakedToolCallMarkup(`\`\`\`code\` demo\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when an unclosed fence inside a blockquote precedes a bare leak outside it', () => {
    // 容器边界:引用里未闭合的围栏只吞到该引用段末尾,不吞引用外的真实泄漏。
    expect(
      detectLeakedToolCallMarkup(`文档引用:\n> \`\`\`xml\n然后模型泄漏了真实调用:\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when the markers only appear inside a fence opened on a list item', () => {
    // 列表项内的围栏示例(- ```xml,内容与闭栏随列表边距缩进 2 空格)是合法
    // 文档形态,不命中。
    const listFence = `语法示例:\n- \`\`\`xml\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>\n  \`\`\`\n以上。`;
    expect(detectLeakedToolCallMarkup(listFence)).toBeNull();
  });

  it('does not hit when the fence sits on an ordered list item', () => {
    const listFence = `步骤:\n1. \`\`\`python\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`;
    expect(detectLeakedToolCallMarkup(listFence)).toBeNull();
  });

  it('still hits on a bare leak after a closed list-item fence', () => {
    // 列表围栏闭合后,其后的真实泄漏保持可检出。
    expect(
      detectLeakedToolCallMarkup(`示例:\n- \`\`\`xml\n  demo\n  \`\`\`\n\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a list fence indents its contents with tabs', () => {
    // tab 按列宽展开(CommonMark):tab 缩进的围栏内容不能被数成零缩进而提前
    // 隐式闭栏。
    const listFence = `示例:\n- \`\`\`xml\n\tinvoke name="Bash">\n\t<parameter name="command">ls</parameter>\n\t\`\`\`\n完。`;
    expect(detectLeakedToolCallMarkup(listFence)).toBeNull();
  });

  it('does not hit when the fence sits on a nested list item', () => {
    // 嵌套列表(- - ```xml):列表标记可叠加。
    const nested = `示例:\n- - \`\`\`xml\n    invoke name="Bash">\n    <parameter name="command">ls</parameter>\n    \`\`\`\n完。`;
    expect(detectLeakedToolCallMarkup(nested)).toBeNull();
  });

  it('does not hit when a dedented fence line reopens at top level after a list fence', () => {
    // 低于列表内容列的围栏行不是内层闭栏:它已退出列表项,是新的顶层开栏 ——
    // 其后的标记在新围栏里,渲染为代码,不是泄漏。
    expect(
      detectLeakedToolCallMarkup(
        `示例:\n- \`\`\`xml\n  demo\n\`\`\`\ninvoke name="Bash">\n<parameter name="command">ls</parameter>`,
      ),
    ).toBeNull();
  });

  it('does not hit on entity-escaped marker demonstrations (&lt;invoke)', () => {
    expect(
      detectLeakedToolCallMarkup(
        '协议形态是 &lt;invoke name="Bash"> 后跟 &lt;parameter name="command">ls</parameter> 这样的结构。',
      ),
    ).toBeNull();
  });

  it('does not hit on backslash-escaped marker demonstrations (\\<invoke)', () => {
    expect(
      detectLeakedToolCallMarkup(
        '写成 \\<invoke name="Bash"> 与 \\<parameter name="command">ls</parameter> 时是转义示例。',
      ),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside an HTML comment', () => {
    // 渲染端 skipHtml:注释里的协议示例用户看不到,不算泄漏。
    expect(
      detectLeakedToolCallMarkup(
        `说明如下。\n<!-- <invoke name="Bash">\n<parameter name="command">ls</parameter> -->\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit on numeric character reference escapes (&#60; / &#x3c;)', () => {
    expect(
      detectLeakedToolCallMarkup(
        '写法是 &#60;invoke name="Bash"> 后跟 &#x3C;parameter name="command">ls</parameter>。',
      ),
    ).toBeNull();
  });

  it('does not hit when a continuation-line fence in a list item wraps the markers', () => {
    // 围栏开在列表项续行上(- Example: 换行后缩进 ```xml):列表上下文把它
    // 绑回列表项,块内示例不命中。
    expect(
      detectLeakedToolCallMarkup(
        `- Example:\n  \`\`\`xml\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>\n  \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when the list content column exceeds 3 and the fence sits on a continuation line', () => {
    // `-   Example:` 的内容列为 4:续行围栏缩进 4 列仍是列表项内的合法围栏,
    // 开栏缩进上限是「内容列 + 3」而非固定 3。
    expect(
      detectLeakedToolCallMarkup(
        `-   Example:\n    \`\`\`xml\n    invoke name="Bash">\n    <parameter name="command">ls</parameter>\n    \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when tab-indented example lines follow a deep list fence (ambiguous columns)', () => {
    // 内容列 5(三空格 + `- `)+ tab 缩进内容(展开 4 列):tab 停靠位歧义,
    // fail-open 按「缩进足够」留在围栏里,不把正常示例误报成泄漏。
    expect(
      detectLeakedToolCallMarkup(
        `   - \`\`\`xml\n\tinvoke name="Bash">\n\t<parameter name="command">ls</parameter>\n\t\`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when an unclosed continuation-line list fence ends with the list', () => {
    // 续行围栏未闭合:低于列表内容列的非空行结束列表项与围栏,其后的真实
    // 泄漏保持可检出。
    expect(
      detectLeakedToolCallMarkup(
        `- Example:\n  \`\`\`xml\n  内容被截断了\n${CLASS_B_LEAK}`,
      ),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when an unclosed list-item fence ends with the list (implicit close)', () => {
    // CommonMark:列表围栏内容必须缩进到列表项内容列,低于该缩进的非空行结束
    // 列表项与其中未闭合的围栏 —— 列表外的真实泄漏不能被吞掉。
    expect(
      detectLeakedToolCallMarkup(`示例:\n- \`\`\`xml\n  内容被截断了\n\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when the markers only appear inside a <script> raw HTML block', () => {
    // 渲染端 skipHtml:script 容器整块隐藏。
    expect(
      detectLeakedToolCallMarkup(
        `示例:\n<script type="text/plain">\ninvoke name="Bash">\n<parameter name="command">ls</parameter>\n</script>\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside a <div> HTML block (until blank line)', () => {
    expect(
      detectLeakedToolCallMarkup(
        `示例:\n<div class="demo">\ninvoke name="Bash">\n<parameter name="command">ls</parameter>\n</div>\n\n以上。`,
      ),
    ).toBeNull();
  });

  it('still hits when the leak follows a closed HTML block after a blank line', () => {
    expect(
      detectLeakedToolCallMarkup(`<div>说明</div>\n\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when an unclosed list-item HTML block ends with the list', () => {
    // 开在列表续行上的未闭合 <script> 随列表项结束而终止(与围栏同规则),
    // 列表外的真实泄漏保持可检出。
    expect(
      detectLeakedToolCallMarkup(`- Example:\n  <script>\n  demo\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a list-item HTML block wraps the markers and stays in the list', () => {
    expect(
      detectLeakedToolCallMarkup(
        `- Example:\n  <script>\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>\n  </script>\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when a fence sits inside a blockquote nested in a list item', () => {
    // `- > \`\`\`xml`:列表项里嵌引用的合法组合,整块按引用容器递归处理。
    expect(
      detectLeakedToolCallMarkup(
        `示例:\n- > \`\`\`xml\n  > invoke name="Bash">\n  > <parameter name="command">ls</parameter>\n  > \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when a raw HTML block sits at deep list continuation indentation', () => {
    // `-   Example:` 内容列 4:四空格缩进的 <script> 块仍是列表项内的 HTML 块。
    expect(
      detectLeakedToolCallMarkup(
        `-   Example:\n    <script>\n    invoke name="Bash">\n    <parameter name="command">ls</parameter>\n    </script>\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit on uppercase named entity escapes (&LT;invoke)', () => {
    expect(
      detectLeakedToolCallMarkup(
        '写法是 &LT;invoke name="Bash"> 后跟 &LT;parameter name="command">ls</parameter>。',
      ),
    ).toBeNull();
  });

  it('does not hit when a raw HTML block opens on the list marker line itself', () => {
    // `- <script>`:HTML 块直接开在列表项标记行上,块内示例整块隐藏。
    expect(
      detectLeakedToolCallMarkup(
        `- <script>\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>\n  </script>\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits after an unclosed list-marker HTML block ends with the list', () => {
    expect(
      detectLeakedToolCallMarkup(`- <script>\n  demo\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a fence sits inside a quote beneath nested list items', () => {
    // `- - > \`\`\`xml`:叠加列表标记 + 引用的组合,引用前缀允许可叠加标记。
    expect(
      detectLeakedToolCallMarkup(
        `示例:\n- - > \`\`\`xml\n    > invoke name="Bash">\n    > <parameter name="command">ls</parameter>\n    > \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when an unclosed list-item HTML comment ends with the list', () => {
    // 开在列表项里的未闭合 <!-- 随列表项结束终止,不吞容器外的真实泄漏。
    expect(
      detectLeakedToolCallMarkup(`- <!-- 示例说明\n  更多说明\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a top-level unclosed comment hides the rest of the response', () => {
    // 顶层未闭合注释:渲染端 skipHtml 下其后整段不展示,与剥离语义一致。
    expect(
      detectLeakedToolCallMarkup(
        `说明。\n<!-- 被截断的注释\ninvoke name="Bash">\n<parameter name="command">ls</parameter>`,
      ),
    ).toBeNull();
  });

  it('still hits when an unclosed comment opener sits in an indented code block', () => {
    // 缩进代码块里的 <!-- 是展示的代码不是注释开栏,不能吞掉其后 dedent 的
    // 真实泄漏。
    expect(
      detectLeakedToolCallMarkup(`说明:\n\n    <!-- 缩进代码里的注释开头\n\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a quoted fence sits at deep list continuation indent', () => {
    // `-   Example:` 内容列 4:四空格缩进的 > 行仍是列表项内的引用容器。
    expect(
      detectLeakedToolCallMarkup(
        `-   Example:\n    > \`\`\`xml\n    > invoke name="Bash">\n    > <parameter name="command">ls</parameter>\n    > \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when a leak sits between literal `<!--` and `-->` code spans', () => {
    // inline code span 先于注释剥离(CommonMark 优先级):两个字面量分隔符
    // 不能被拼成一段注释把中间的真实泄漏吞掉。
    expect(
      detectLeakedToolCallMarkup(
        `起始标记写作 \`<!--\`。\n${CLASS_B_LEAK}结束标记写作 \`-->\`。`,
      ),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when an ordered-list fence opener cannot interrupt the paragraph', () => {
    // CommonMark:起始编号 ≠1 的有序列表不能打断段落 —— 紧跟段落行的
    // `2. \`\`\`xml` 是段落延续文本,不是围栏,不能吞掉其后的真实泄漏。
    expect(
      detectLeakedToolCallMarkup(`前面是一段说明文字\n2. \`\`\`xml\n随后模型泄漏了调用:\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when an ordered-list fence follows a blank line (valid list)', () => {
    expect(
      detectLeakedToolCallMarkup(
        `说明:\n\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when an inline comment opener and closer sit in different paragraphs', () => {
    // 行内 <!-- 不能跨空行与后续段落的 --> 组成注释,中间段落的真实泄漏可见。
    expect(
      detectLeakedToolCallMarkup(
        `前文提到 <!-- 这个开头。\n\n${CLASS_B_LEAK}\n尾部提到 --> 这个结束。`,
      ),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when an ordered-list fence follows a heading or thematic break', () => {
    // 标题/分隔线之后没有敞开的段落,`2.` 开启的围栏是合法列表围栏
    // (第二十四轮 Codex review:段落状态不能把所有非空行都当段落)。
    expect(
      detectLeakedToolCallMarkup(
        `# 步骤\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
    expect(
      detectLeakedToolCallMarkup(
        `前文说明。\n***\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when an ordered fence continues an existing list', () => {
    // 打断限制只约束「打断段落的新列表首项」:已在列表里的 `2.` 是兄弟项,
    // 其围栏合法(第二十四轮 Codex review)。
    expect(
      detectLeakedToolCallMarkup(
        `1. 第一步说明\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside a processing-instruction block', () => {
    // CommonMark HTML 块 type 3:<? 到 ?> 所在行为止,skipHtml 下整块隐藏
    // (第二十四轮 Codex review)。
    expect(
      detectLeakedToolCallMarkup(`<?demo\n${CLASS_B_LEAK}?>\n以上是说明。`),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside a CDATA block', () => {
    // type 5:<![CDATA[ 到 ]]> 所在行为止。
    expect(
      detectLeakedToolCallMarkup(`<![CDATA[\n${CLASS_B_LEAK}]]>\n以上是说明。`),
    ).toBeNull();
  });

  it('does not hit when the markers only appear inside a declaration block', () => {
    // type 4:<! + 字母,到 > 所在行(含)为止 —— invoke 行自带 > 即闭合行,
    // 连同其上的声明行一起剥掉;后续 parameter 单独出现不构成命中。
    expect(
      detectLeakedToolCallMarkup(`<!ATTLIST 示例\n${CLASS_B_LEAK}以上是说明。`),
    ).toBeNull();
  });

  it('still hits when a leak follows a single-line declaration', () => {
    // 同一行闭合的声明只剥当前行,其后的真实泄漏仍要判。
    expect(detectLeakedToolCallMarkup(`<!DOCTYPE html>\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('does not hit when an ordered fence follows a closed raw HTML block', () => {
    // 原始 HTML 块行不是段落文本(第二十五轮 Codex review):块结束后的
    // `2.` 围栏没有段落可打断,是合法开栏。单行块与多行块都要覆盖。
    expect(
      detectLeakedToolCallMarkup(
        `<script></script>\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
    expect(
      detectLeakedToolCallMarkup(
        `<script>\nvar x = 1\n</script>\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when an ordered fence follows a block quote (round 26)', () => {
    // 实测(micromark,与渲染端一致):引用行(含惰性延续行)之后的非 1 有序
    // 围栏会结束引用并合法开栏 —— 引用段落不算「可被打断的段落」。
    expect(
      detectLeakedToolCallMarkup(
        `> 说明引文\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
    expect(
      detectLeakedToolCallMarkup(
        `> 说明引文\n惰性延续行\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('does not hit when a valid fence follows a dedent out of a list-item HTML block', () => {
    // 段落视角的 HTML 块状态同样随列表项终止(第二十六轮 Codex review):
    // `- <script>` 的抑制不能越过 dedent 边界,其后的标题 + `2.` 围栏是
    // 合法结构,围栏内容要剥掉。
    expect(
      detectLeakedToolCallMarkup(
        `- <script>\n# 标题\n2. \`\`\`xml\n   invoke name="Bash">\n   <parameter name="command">ls</parameter>\n   \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when a leak dedents out of a list-item HTML block', () => {
    // 容器边界的另一面:dedent 出列表项后的真实泄漏不被未闭合块吞掉。
    expect(detectLeakedToolCallMarkup(`- <script>\n  块内内容\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('does not hit when the markers only appear inside a lowercase declaration block', () => {
    // CommonMark 0.30 起 type 4 允许任意 ASCII 字母(渲染端 micromark 的
    // declarationOpen 即 asciiAlpha):`<!doctype` 等小写声明同样整块隐藏。
    expect(
      detectLeakedToolCallMarkup(`<!doctype 示例\n${CLASS_B_LEAK}以上是说明。`),
    ).toBeNull();
  });

  it('still hits when a fence-looking line sits inside an HTML block before a real leak', () => {
    // HTML 块内容是 raw 文本:块内的 \`2. \`\`\`xml\` 不是围栏开栏,不能把
    // 块外的真实泄漏吞进围栏态。
    expect(
      detectLeakedToolCallMarkup(`<?demo\n2. \`\`\`xml\n?>\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when a leak follows a list-bounded unclosed processing instruction', () => {
    // 开在列表项里的未闭合 <? 随列表项结束终止(容器边界与 type 1/6 同规则),
    // 列表外的真实泄漏不被吞掉。
    expect(
      detectLeakedToolCallMarkup(`- <?php 示例片段\n  仍在列表项里\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when a fence follows an ordered marker that stayed in the paragraph', () => {
    // 段落后不能打断段落的 `2.  Example` 是段落延续文本,不建立列表上下文
    // (第二十七轮 Codex review):其后四空格缩进的 ~~~ 行同样是段落延续,
    // 里面的标记是可见正文,必须判。
    expect(
      detectLeakedToolCallMarkup(
        `正文说明\n2.  Example:\n    ~~~xml\n    invoke name="Bash">\n    <parameter name="command">ls</parameter>\n    ~~~`,
      ),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('does not hit when a real ordered list carries an indented fence after a blank line', () => {
    // 对照组:空行后的 `2.` 是合法列表,续行缩进围栏正常剥离。
    expect(
      detectLeakedToolCallMarkup(
        `说明:\n\n2.  Example:\n    ~~~xml\n    invoke name="Bash">\n    <parameter name="command">ls</parameter>\n    ~~~\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when text starts with a slash-broken tag before a real leak', () => {
    // `<div/foo`、`<script/foo` 的裸 `/` 不是 type 1/6 的标签名终止符
    // (CommonMark:空白 / `>` / 行尾,type 6 另加完整 `/>`),不是 HTML 块,
    // 其后的真实泄漏可见,必须判。
    expect(detectLeakedToolCallMarkup(`<div/foo 提示\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
    expect(detectLeakedToolCallMarkup(`<script/foo 提示\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('does not hit when the markers sit inside a self-closing type-6 block', () => {
    // 对照组:`<div/>` 的 `/>` 是合法终止符,块到空行为止,块内标记不判。
    expect(detectLeakedToolCallMarkup(`<div/>\n${CLASS_B_LEAK}以上是说明。`)).toBeNull();
  });

  it('still hits when a leak dedents out of an empty-marker list fence', () => {
    // 单独成行的 `-` 是空列表项(内容列 = 标记末列 + 1,第二十八轮 Codex
    // review):其下缩进的未闭合围栏随 dedent 隐式闭栏,列表外的真实泄漏
    // 不被吞到输入末尾。
    expect(detectLeakedToolCallMarkup(`-\n  \`\`\`xml\n  示例内容\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('does not hit when the markers sit inside an empty-marker list fence', () => {
    // 对照组:空标记项内正常闭合的围栏照常剥离。
    expect(
      detectLeakedToolCallMarkup(
        `-\n  \`\`\`xml\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>\n  \`\`\`\n完。`,
      ),
    ).toBeNull();
  });

  it('still hits when a leak dedents out of an empty-marker HTML block after a heading', () => {
    // 空标记识别不限于空行之后(第三十轮 Codex review):标题等块边界后无
    // 空行的 `-` 同样建立列表项,项内未闭合 HTML 块随 dedent 终止。
    expect(
      detectLeakedToolCallMarkup(`# 标题\n-\n  <script>\n  示例内容\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
  });

  it('still hits when a leak dedents out of an empty-marker list HTML block', () => {
    // stripHtmlBlocks 的列表上下文同样识别空标记行(第二十九轮 Codex
    // review):`-` 项内的未闭合 <script> 随 dedent 终止,列表外真实泄漏不被
    // 吞到输入末尾。
    expect(detectLeakedToolCallMarkup(`-\n  <script>\n  示例内容\n${CLASS_B_LEAK}`)).toEqual({
      category: 'invoke-with-parameter',
    });
  });

  it('does not hit when the markers stay inside an empty-marker list HTML block', () => {
    // 对照组:块内(同缩进)的标记仍随块剥离。
    expect(
      detectLeakedToolCallMarkup(
        `-\n  <script>\n  invoke name="Bash">\n  <parameter name="command">ls</parameter>`,
      ),
    ).toBeNull();
  });

  it('does not treat a mixed-character line as a closing fence', () => {
    // CommonMark 闭栏必须与开栏同字符:``` 栏内出现 ```~~~ 行不是闭栏,块内
    // 后续的标记示例仍在围栏里,不命中。
    expect(
      detectLeakedToolCallMarkup(`示例:\n\`\`\`\n\`\`\`~~~\n${CLASS_B_LEAK}\`\`\`\n后文。`),
    ).toBeNull();
  });

  it('does not let an inner shorter fence close an outer longer fence early', () => {
    // 外层 ```` 包住含 ``` 的内容(CommonMark 嵌套围栏惯用法):内层 ``` 不闭合
    // 外层,泄漏标记始终在围栏内,不命中。
    expect(
      detectLeakedToolCallMarkup(
        `文档片段:\n\`\`\`\`md\n\`\`\`xml\n${CLASS_B_LEAK}\`\`\`\n\`\`\`\`\n完。`,
      ),
    ).toBeNull();
  });
});

describe('Claude Code translator leaked tool markup guard (#2518)', () => {
  it('emits a terminal malformed-tool-markup error but keeps Done + done for usage accounting', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: CLASS_B_LEAK }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    const err = events.find((e) => e.type === 'error');
    expect(err?.data).toMatchObject({ reason: 'malformed-tool-markup', isTerminal: true });
    // 与 empty-response 不同:本轮有真实用量,必须保留 status Done + done 保住记账
    // (is_error 失败序列同构:error → status Done → done)。
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(
      events.some((e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done'),
    ).toBe(true);
    // 日志不携带正文,只有类别与长度。
    const warn = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls.find(([m]) =>
      String(m).includes('leaked malformed tool-call markup'),
    );
    expect(warn).toBeDefined();
    expect(JSON.stringify(warn?.[1])).not.toContain('parameter name=');
  });

  it('aggregates streaming text deltas for detection', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    const half = Math.floor(CLASS_B_LEAK.length / 2);
    for (const chunk of [CLASS_B_LEAK.slice(0, half), CLASS_B_LEAK.slice(half)]) {
      translateSdkMessage(
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } },
        },
        queue,
        ctx,
      );
    }
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('does not flag a normal text turn', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '正常回答:用 `(\\d{4})` 匹配年份即可。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does not flag fenced markup discussion that precedes a successful structured tool call', async () => {
    // 讨论语境:tool_use 之前的段落在推进偏移时也会单独过一遍检测器,但围栏/
    // 行内代码里的演示会被剥离 —— 正常的语法讲解不触发。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: `先解释一下这条被截断的调用长什么样:\n\`\`\`\n${CLASS_B_LEAK}\`\`\`\n现在实际执行。`,
            },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '读完了,内容正常。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('flags a malformed call that precedes a valid tool_use in the same turn (Codex review)', async () => {
    // 平行调用形态:模型想发两个调用,第一个写坏成纯文本、第二个正常解析 ——
    // 坏调用文本落在 tool_use 之前的段里,推进偏移前的分段检测要接住它,
    // 不能把 tool_use 之前的文本一律当讨论语境。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: CLASS_B_LEAK },
            { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/tmp/b' } },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '第二个调用读完了。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('flags a leak that appears after the last successful tool call (Codex review)', async () => {
    // 先成功调了一个工具、随后第二个调用写坏成纯文本 —— toolUses 累计非零不能
    // 全免判定,只豁免最后一次 tool_use 之前的正文。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } }],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: CLASS_B_LEAK }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('flags a leak only present in a mismatched result body on a zero-tool turn (Greptile review)', async () => {
    // mismatch 分支:result.result 与已流式正文前缀对不上(fallbackTail 为空、
    // full 不展示),但泄漏只在 full 里时「工具没执行却按成功收口」的伤害不变
    // —— 零 tool 轮补扫 full。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '我马上执行。' }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx, `完全错位的最终正文:\n${CLASS_B_LEAK}`);

    const events = await drain(queue);
    // mismatch 保守不补推正文(既有截断兜底语义不变)。
    expect(
      events.some((e) => e.type === 'text' && String((e.data as { text?: string }).text).includes('invoke')),
    ).toBe(false);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('flags a leak that only exists in the unstreamed result tail (Greptile review)', async () => {
    // 流式只推过正常旁白,泄漏标记只在 result.result 兜出的尾段里(该尾段上方
    // 刚补推给 UI)—— 检测必须覆盖「用户实际看到的全文」,不能只扫 emitted。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    const preamble = '我来执行这一步。\n';
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: preamble }] } },
      queue,
      ctx,
    );
    pushResult(queue, ctx, `${preamble}${CLASS_B_LEAK}`);

    const events = await drain(queue);
    // 尾段先按流式截断兜底补推给 UI,再触发泄漏判定。
    expect(
      events.some((e) => e.type === 'text' && (e.data as { text?: string }).text === CLASS_B_LEAK),
    ).toBe(true);
    expect(events.find((e) => e.type === 'error')?.data).toMatchObject({
      reason: 'malformed-tool-markup',
      isTerminal: true,
    });
  });

  it('does not flag when the user interrupted the turn', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushMessageStart(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: CLASS_B_LEAK }] } },
      queue,
      ctx,
    );
    ctx.turn.interruptRequested = true;
    pushResult(queue, ctx);

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
