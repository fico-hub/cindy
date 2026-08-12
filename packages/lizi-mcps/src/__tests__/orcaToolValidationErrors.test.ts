/**
 * Orca 顶层工具的可行动参数校验回归(#2410)。
 *
 * 必须经真实 createOrcaMcpServer + InMemoryTransport + SDK Client 调用 ——
 * 校验发生在 MCP SDK 的 CallTool 请求处理层,只测 registry/handler 会绕过
 * 实际被增强的路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createOrcaMcpServer, type OrcaMcpDeps } from '../orca/server.js';
import {
  buildActionableInputSchema,
  minimalExampleForShape,
  requiredKeysOfShape,
} from '../orca/actionableToolErrors.js';
import { z } from 'zod';

function createOrcaDeps(overrides: Partial<OrcaMcpDeps> = {}): OrcaMcpDeps {
  return {
    startTeam: vi.fn(async () => ({
      ok: true as const,
      teamId: 'team-1',
      workerPermissionMode: 'auto' as const,
    })),
    createWorker: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
    })),
    listWorkers: vi.fn(async () => ({ ok: true as const, workers: [] })),
    switchFocus: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    sendToWorker: vi.fn(async () => ({
      ok: true as const,
      agentKind: 'codex' as const,
      wakeKind: 'already-active' as const,
      targetTitle: null,
      targetLastUserSendAt: null,
    })),
    listWorkerQueuedMessages: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      workerSessionId: 'worker-session-1',
      messages: [],
    })),
    updateWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    cancelWorkerQueuedMessage: vi.fn(async () => ({
      ok: true as const,
      workerId: 'worker-1',
      queuedMessageId: 'queued-1',
    })),
    idleWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    endTeam: vi.fn(async () => ({ ok: true as const })),
    archiveWorker: vi.fn(async () => ({ ok: true as const, workerId: 'worker-1' })),
    listAvailableModels: vi.fn(async () => ({ ok: true as const })),
    getWorkspaceInfo: vi.fn(async () => ({
      ok: true as const,
      workflow: {
        workflow_id: 'team-1',
        lead_session_id: 'lead-1',
        status: 'active',
      },
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    })),
    getWorkerStatus: vi.fn(async () => ({
      ok: true as const,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      idle_ms: 123,
      restored_from_storage: true,
    })),
    ...overrides,
  };
}

async function connect(deps: OrcaMcpDeps) {
  const server = createOrcaMcpServer(deps, {
    agentKind: 'claude-code',
    workingDir: '/repo',
    sessionId: 'lead-1',
  });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orca-validation-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  return client;
}

async function callToolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // SDK client 把服务端 McpError 转成 isError 结果而不是抛异常。
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content?.[0]?.text ?? '';
  if (!text.includes('Input validation error')) {
    throw new Error(`expected ${name} call to fail validation, got: ${text.slice(0, 200)}`);
  }
  return text;
}

describe('orca 顶层工具的可行动参数校验(#2410)', () => {
  it('create_worker 的 {args:{...}} 误用一次报全:平铺提示 + 全部必填字段 + 意外 args', async () => {
    const deps = createOrcaDeps();
    const client = await connect(deps);

    const message = await callToolError(client, 'create_worker', {
      args: { role: 'reviewer', agent: 'codex', label: 'r1' },
    });

    // 顶层 args 不再被静默剥离:形态提示 + 最小示例。
    expect(message).toContain('args');
    expect(message).toContain('平铺');
    expect(message).toContain('必填字段');
    // 一次报全:三个必填字段同时出现在错误里。
    for (const field of ['role', 'agent', 'label']) {
      expect(message).toContain(`"${field}"`);
    }
    // host 创建回调完全没被调用。
    expect(deps.createWorker).not.toHaveBeenCalled();
  });

  it('create_workers 的 {args:{...}} 误用同时报 workers 缺失与意外 args,且不回显正文', async () => {
    const deps = createOrcaDeps();
    const client = await connect(deps);
    const secret = 'SENSITIVE-INITIAL-TASK-BODY-8f3a';

    const message = await callToolError(client, 'create_workers', {
      args: {
        workers: [
          { role: 'reviewer', agent: 'codex', label: 'r1', initial_task: secret },
          { role: 'reviewer', agent: 'codex', label: 'r2', initial_task: secret },
        ],
      },
    });

    expect(message).toContain('args');
    expect(message).toContain('平铺');
    expect(message).toContain('workers');
    // 错误不回显原始参数值(可能含任务正文等敏感内容)。
    expect(message).not.toContain(secret);
    expect(deps.createWorker).not.toHaveBeenCalled();
  });

  it('普通字段类型错误仍一次报全,且不误加 args 平铺提示', async () => {
    const deps = createOrcaDeps();
    const client = await connect(deps);

    const message = await callToolError(client, 'create_worker', {
      role: 123,
      agent: 'not-an-agent',
      label: 'ok_label',
    });

    expect(message).toContain('role');
    expect(message).toContain('agent');
    expect(message).not.toContain('平铺');
  });

  it('正确的平铺调用照常进入 handler,传参与返回值不变', async () => {
    const deps = createOrcaDeps();
    const client = await connect(deps);

    const result = (await client.callTool({
      name: 'create_worker',
      arguments: { role: 'reviewer', agent: 'codex', label: 'r1' },
    })) as { content: Array<{ type: string; text: string }> };

    expect(deps.createWorker).toHaveBeenCalledTimes(1);
    expect(deps.createWorker).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'reviewer', agent: 'codex', label: 'r1' }),
    );
    const payload = JSON.parse(result.content[0]!.text) as { ok?: boolean };
    expect(payload.ok).toBe(true);
  });

  it('发现层 inputSchema 保持平铺契约(required 字段仍在,校验接管不影响发布)', async () => {
    const client = await connect(createOrcaDeps());
    const { tools } = await client.listTools();
    const createWorkers = tools.find((t) => t.name === 'create_workers');
    expect(createWorkers).toBeDefined();
    const schema = createWorkers!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toContain('workers');
    expect(schema.required ?? []).toContain('workers');
  });
});

describe('schema 派生的必填清单与示例(不手写,不随演进过期)', () => {
  const workerShape = {
    role: z.string(),
    agent: z.enum(['claude-code', 'codex', 'pi']),
    label: z.string(),
    initial_task: z.string().optional(),
  };

  it('requiredKeysOfShape 只取不接受 undefined 的字段', () => {
    expect(requiredKeysOfShape(workerShape)).toEqual(['role', 'agent', 'label']);
  });

  it('最小示例满足数组最小长度约束,且自身可通过校验', () => {
    const shape = {
      workers: z.array(z.strictObject(workerShape)).min(2).max(32),
    };
    const example = minimalExampleForShape(shape);
    expect(Array.isArray(example.workers)).toBe(true);
    expect((example.workers as unknown[]).length).toBeGreaterThanOrEqual(2);
    // 示例自身必须能通过接管 schema 的校验 —— 否则提示会误导调用方。
    expect(buildActionableInputSchema('create_workers', shape).safeParse(example).success).toBe(
      true,
    );
  });

  it('enum 字段的示例取首个合法值', () => {
    const example = minimalExampleForShape(workerShape) as { agent?: string };
    expect(['claude-code', 'codex', 'pi']).toContain(example.agent);
  });
});
