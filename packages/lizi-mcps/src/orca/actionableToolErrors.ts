/**
 * 顶层直接注册 MCP 工具的可行动参数校验(#2410)。
 *
 * MCP SDK 在业务 handler 之前用注册的 zod schema 校验参数。此前 DirectToolSink
 * 只把 raw shape 交给 SDK,SDK 内部按 `z.object(shape)`(非 strict)解析 ——
 * 顶层未知键被**静默剥离**。典型误用是把 `ghost_call` 风格的 `{args: {...}}`
 * 包裹套到平铺工具上:`args` 被剥掉后只剩「必填字段全部缺失」的裸错误,调用方
 * (尤其推理较弱的模型)反复重试也无法定位形态问题。
 *
 * 这里把校验 schema 换成 strictObject + 对象级 error 定制:
 *  - 顶层未知键不再被剥,和缺失字段**一次报全**(zod 单次 parse 聚合全部 issue);
 *  - 未知键含 `args` 时附「参数须平铺,不要包 args」的针对性提示;
 *  - 附由 schema 派生的必填字段清单与最小正确示例(不手写,不随演进过期);
 *  - 字段级错误保持 zod 默认文案(自带 expected/received 类型摘要),**不回显
 *    原始值** —— 参数可能含任务正文等敏感内容。
 *
 * 发布层(tools/list 的 inputSchema)与业务契约不变:平铺形态仍是唯一合法
 * 调用形态,不兼容 `{args: ...}`。
 */

import { z, type ZodRawShape, type ZodType } from 'zod';

function isOptionalSchema(schema: ZodType): boolean {
  return schema.safeParse(undefined).success;
}

/** shape 里必填(不接受 undefined)的顶层字段名,声明序。 */
export function requiredKeysOfShape(shape: ZodRawShape): string[] {
  return Object.entries(shape)
    .filter(([, schema]) => !isOptionalSchema(schema as ZodType))
    .map(([key]) => key);
}

type AnyDef = {
  type?: string;
  innerType?: ZodType;
  element?: ZodType;
  entries?: Record<string, unknown>;
  values?: unknown[];
  options?: ZodType[];
  shape?: ZodRawShape;
};

function defOf(schema: ZodType): AnyDef {
  const v4 = (schema as unknown as { _zod?: { def?: AnyDef } })._zod?.def;
  if (v4) return v4;
  return ((schema as unknown as { _def?: AnyDef })._def ?? {}) as AnyDef;
}

/**
 * 按 schema 递归生成占位示例值。目标是「形态正确、可通过校验」而不是语义
 * 真实:enum/literal 取首个合法值,数组按最小长度补足,optional 字段省略。
 * 未识别的类型退回 '<value>' 占位(示例仍具形态指导意义)。
 */
function exampleForSchema(schema: ZodType): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
    case 'default':
    case 'nullable':
    case 'catch':
      return def.innerType ? exampleForSchema(def.innerType) : '<value>';
    case 'string':
      return '<string>';
    case 'number':
    case 'int':
      return 0;
    case 'boolean':
      return false;
    case 'enum': {
      const values = def.entries ? Object.values(def.entries) : def.values;
      return values && values.length > 0 ? values[0] : '<enum>';
    }
    case 'literal':
      return def.values && def.values.length > 0 ? def.values[0] : '<literal>';
    case 'array': {
      if (!def.element) return [];
      const item = exampleForSchema(def.element);
      // 数组可能带最小长度约束(如 create_workers 的 2–32):从 1 个开始补到
      // 能通过校验为止,封顶 3 —— 示例自身不可通过校验会误导调用方。
      for (let count = 1; count <= 3; count += 1) {
        const candidate = Array.from({ length: count }, () => item);
        if (schema.safeParse(candidate).success) return candidate;
      }
      return [item, item];
    }
    case 'object': {
      const shape = def.shape ?? {};
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (!isOptionalSchema(field as ZodType)) out[key] = exampleForSchema(field as ZodType);
      }
      return out;
    }
    case 'union':
      return def.options && def.options.length > 0 ? exampleForSchema(def.options[0]) : '<value>';
    default:
      return '<value>';
  }
}

/** 只含必填字段的最小示例对象(供错误文案引用)。 */
export function minimalExampleForShape(shape: ZodRawShape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    if (!isOptionalSchema(field as ZodType)) out[key] = exampleForSchema(field as ZodType);
  }
  return out;
}

/**
 * 构造接管 SDK 校验用的严格 schema。注册仍用 raw shape(发布 JSON Schema 由
 * shape 生成),本 schema 只替换 RegisteredTool.inputSchema 的校验职责。
 */
export function buildActionableInputSchema(
  toolName: string,
  shape: ZodRawShape,
): ZodType {
  const required = requiredKeysOfShape(shape);
  const example = JSON.stringify(minimalExampleForShape(shape));
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== 'unrecognized_keys') return undefined;
      const keys = (issue as { keys?: string[] }).keys ?? [];
      const argsHint = keys.includes('args')
        ? ` 本工具的参数须直接平铺在顶层,不要包一层 {"args": {...}}。`
        : '';
      return (
        `unexpected top-level key(s): ${keys.join(', ')}.${argsHint}` +
        ` ${toolName} 的必填字段: ${required.join(', ')};` +
        `最小正确调用示例: ${example}(完整字段见本工具已发布的 inputSchema)`
      );
    },
  });
}
