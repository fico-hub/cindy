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
 * 如 ```` 包住含 ``` 的内容)。闭栏用反向引用要求与开栏同字符同长度 —— 更短的
 * 内层围栏不会提前闭合外层;未闭合的围栏(正文被截断)吞到结尾。闭栏比开栏更长
 * 时多余字符残留为普通文本,对标记检测无影响。
 */
const FENCED_CODE_RE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

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
  const text = rawText.replace(FENCED_CODE_RE, '').replace(INLINE_CODE_RE, '');
  const invoke = INVOKE_MARKER_RE.exec(text);
  if (!invoke) return null;
  const afterInvoke = text.slice(invoke.index + invoke[0].length);
  if (!PARAMETER_MARKER_RE.test(afterInvoke)) return null;
  return { category: 'invoke-with-parameter' };
}
