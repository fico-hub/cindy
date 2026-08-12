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

  it('still hits when an unclosed list-item fence ends with the list (implicit close)', () => {
    // CommonMark:列表围栏内容必须缩进到列表项内容列,低于该缩进的非空行结束
    // 列表项与其中未闭合的围栏 —— 列表外的真实泄漏不能被吞掉。
    expect(
      detectLeakedToolCallMarkup(`示例:\n- \`\`\`xml\n  内容被截断了\n\n${CLASS_B_LEAK}`),
    ).toEqual({ category: 'invoke-with-parameter' });
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
