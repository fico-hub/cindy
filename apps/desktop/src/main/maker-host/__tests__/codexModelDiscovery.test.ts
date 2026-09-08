/**
 * codex-model-discovery mapper 单测 —— 用真实 codex models_cache.json 的字段形状,
 * 验证筛选(visibility/supported_in_api)+ 规范化映射 + capability 字段。
 */
import fsp from 'node:fs/promises';
import type { CodexModelListItem } from '@cindy/maker-core';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// codex-model-discovery 顶层 import electron(readCodexDiscoveredModels 用 app.getPath);
// 本套件只测纯 mapper,但按 main 侧测试惯例显式 mock,避免依赖 Node 下 electron 包的
// 「名导出恰好是 undefined 不炸」这种脆弱行为。
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/xdt-codex-model-discovery-test' } }));
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn() } }));

import {
  bumpCodexDiscoveryAuthEpoch,
  createCodexLiveModelsPublisher,
  getCodexDiscoveryAuthEpoch,
  mapCodexModelsToCatalog,
  mapCodexAppServerModelsToCatalog,
  mergeCodexLiveModelsWithCache,
  readCodexDiscoveredModels,
  readCodexDiscoveredModelsBounded,
  readCodexDiscoveredModelsForAuthRefresh,
} from '../codex-model-discovery.js';

// 取自本机 ~/.codex/models_cache.json 的真实结构(裁剪到关键字段)。
const SAMPLE = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'Frontier model.', visibility: 'list', supported_in_api: true, context_window: 272000, default_reasoning_level: 'medium', priority: 7, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', supported_in_api: true, context_window: 272000, default_reasoning_level: 'medium', priority: 16, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], service_tiers: [] },
    // 未来新模型:应被自动纳入(这正是 live 发现要解决的"下周出 5.6")
    { slug: 'gpt-5.6', display_name: 'GPT-5.6', visibility: 'list', supported_in_api: true, context_window: 400000, default_reasoning_level: 'high', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
    // 隐藏 / 非 api 的内部货:应被过滤
    { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', visibility: 'list', supported_in_api: false, context_window: 128000, supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'codex-auto-review', display_name: 'Auto Review', visibility: 'hide', supported_in_api: true, context_window: 272000, supported_reasoning_levels: [{ effort: 'medium' }] },
  ],
};
const OAUTH_AUTH = JSON.stringify({ tokens: { access_token: 'oauth-token' } });

describe('mapCodexModelsToCatalog', () => {
  it('只留 visibility:list && supported_in_api:true,保留规范 slug', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.6']);
    // spark(api:false)与 auto-review(hide)被过滤
    expect(out.find((m) => m.id.includes('spark'))).toBeUndefined();
    expect(out.find((m) => m.id.includes('auto-review'))).toBeUndefined();
  });

  it('cache 即使把内部 ID 标成 list/api:true 也过滤 codex-auto-review', () => {
    const out = mapCodexModelsToCatalog({
      models: [
        {
          slug: 'codex-auto-review',
          display_name: 'GPT-5.6-Luna',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: 'medium' }],
        },
      ],
    });

    expect(out).toEqual([]);
  });

  it('真实 gpt-5.6-luna 即使与内部别名同展示名也在 cache/live 两路保留', () => {
    const cache = mapCodexModelsToCatalog({
      models: [
        {
          slug: 'gpt-5.6-luna',
          display_name: 'GPT-5.6-Luna',
          visibility: 'list',
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: 'high' }],
        },
      ],
    });
    const live = mapCodexAppServerModelsToCatalog([
      {
        id: 'gpt-5.6-luna',
        model: 'gpt-5.6-luna',
        displayName: 'GPT-5.6-Luna',
        description: '',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
        defaultReasoningEffort: 'high',
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: false,
      },
    ] as CodexModelListItem[]);

    expect(cache.map((model) => model.id)).toEqual(['gpt-5.6-luna']);
    expect(live.map((model) => model.id)).toEqual(['gpt-5.6-luna']);
  });

  it('未来新模型(gpt-5.6)自动纳入并带正确 capability —— 印证"下周出 5.6 零手改"', () => {
    const m56 = mapCodexModelsToCatalog(SAMPLE).find((m) => m.id === 'gpt-5.6');
    expect(m56).toBeDefined();
    expect(m56).toMatchObject({
      id: 'gpt-5.6',
      name: 'GPT-5.6',
      group: 'gpt',
      contextWindow: 400000,
      efforts: ['low', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'high',
      status: 'active',
      defaultEnabled: true,
    });
    expect(m56!.effortDisplayNames).toEqual({ xhigh: 'Extra High' });
  });

  it('service_tiers 含 priority → supportsFastMode:true;空/缺省不标(数据驱动,不猜)', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.find((m) => m.id === 'gpt-5.5')?.supportsFastMode).toBe(true);
    expect(out.find((m) => m.id === 'gpt-5.4')?.supportsFastMode).toBeUndefined();
    expect(out.find((m) => m.id === 'gpt-5.6')?.supportsFastMode).toBeUndefined();
  });

  it('display name 保持纯净,保留模型自报的全部合法 effort(含 max/ultra),priority 对齐静态排序锚点', () => {
    const out = mapCodexModelsToCatalog(SAMPLE);
    expect(out.every((m) => !m.name.includes('订阅'))).toBe(true);
    // issue #352:max/ultra 是合法 Codex 档,不再被 CODEX_EFFORTS 白名单过滤掉。
    expect(out.find((m) => m.id === 'gpt-5.6')?.efforts).toEqual(['low', 'high', 'xhigh', 'max', 'ultra']);
    expect(out.find((m) => m.id === 'gpt-5.6')?.sortOrder).toBe(19);
    expect(out.find((m) => m.id === 'gpt-5.5')?.sortOrder).toBe(20);
    expect(out.find((m) => m.id === 'gpt-5.4')?.sortOrder).toBe(21);
  });

  it('只放行 CODEX_EFFORTS 白名单内的档(含 max/ultra),未知 effort id 仍被过滤', () => {
    const out = mapCodexModelsToCatalog({
      models: [
        {
          slug: 'gpt-5.7',
          display_name: 'GPT-5.7',
          visibility: 'list',
          supported_in_api: true,
          context_window: 400000,
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'high' },
            { effort: 'max' },
            { effort: 'ultra' },
            { effort: 'giga' },
          ],
        },
      ],
    });
    expect(out[0].efforts).toEqual(['high', 'max', 'ultra']);
  });

  it('legacy 默认隐藏策略:gpt-5.4-mini defaultEnabled:false(旧目录可见性不因清单动态化漂移)', () => {
    const out = mapCodexModelsToCatalog({
      models: [
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true, context_window: 272000, priority: 23, supported_reasoning_levels: [{ effort: 'high' }] },
      ],
    });
    expect(out[0].defaultEnabled).toBe(false);
  });

  it('坏输入(非对象 / 无 models / 空)→ 空数组,不抛', () => {
    expect(mapCodexModelsToCatalog(null)).toEqual([]);
    expect(mapCodexModelsToCatalog({})).toEqual([]);
    expect(mapCodexModelsToCatalog({ models: 'nope' })).toEqual([]);
    expect(mapCodexModelsToCatalog({ models: [{ slug: 'x', visibility: 'list', supported_in_api: true }] })[0].efforts).toEqual([]);
  });
});

describe('mapCodexAppServerModelsToCatalog', () => {
  it('live 即使把内部 ID 标成 hidden:false 也过滤 codex-auto-review', () => {
    const out = mapCodexAppServerModelsToCatalog([
      {
        id: 'codex-auto-review',
        model: 'codex-auto-review',
        displayName: 'GPT-5.6-Luna',
        description: '',
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }],
        defaultReasoningEffort: 'medium',
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: false,
      },
    ] as CodexModelListItem[]);

    expect(out).toEqual([]);
  });

  it('保留 app-server 顺序、过滤隐藏/重复项并映射 effort 与 fast tier', () => {
    const out = mapCodexAppServerModelsToCatalog([
      {
        id: 'gpt-5.6',
        model: 'gpt-5.6',
        displayName: 'GPT-5.6',
        description: 'Newest',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'xhigh', description: '' },
        ],
        defaultReasoningEffort: 'xhigh',
        additionalSpeedTiers: [],
        serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }],
        isDefault: true,
      },
      {
        id: 'hidden', model: 'hidden', displayName: 'Hidden', description: '', hidden: true,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', additionalSpeedTiers: [],
        serviceTiers: [], isDefault: false,
      },
      {
        id: 'duplicate', model: 'gpt-5.6', displayName: 'Duplicate', description: '', hidden: false,
        supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', additionalSpeedTiers: [],
        serviceTiers: [], isDefault: false,
      },
      {
        id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini', description: '', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
        defaultReasoningEffort: 'high', additionalSpeedTiers: [], serviceTiers: [], isDefault: false,
      },
    ] as CodexModelListItem[]);

    expect(out.map((model) => model.id)).toEqual(['gpt-5.6', 'gpt-5.4-mini']);
    expect(out[0]).toMatchObject({
      contextWindow: 272_000,
      efforts: ['low', 'xhigh'],
      defaultEffort: 'xhigh',
      supportsFastMode: true,
      sortOrder: 17,
    });
    expect(out[1].defaultEnabled).toBe(false);
    expect(out[1].sortOrder).toBe(17.003);
    // live 协议不给 context_window,这 272k 是统一兜底 → 一律不得标记为已核实。
    // 标了它就会被拿去收敛运行期上报的窗口,把真实更大的窗口压成 272k。
    expect(out.every((model) => model.contextWindowVerified === undefined)).toBe(true);
  });
});

describe('mergeCodexLiveModelsWithCache (#4087)', () => {
  const liveItem = (slug: string, displayName: string): CodexModelListItem =>
    ({
      id: slug, model: slug, displayName, description: '', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      defaultReasoningEffort: 'high', additionalSpeedTiers: [], serviceTiers: [], isDefault: false,
    }) as CodexModelListItem;

  it('刷新走 live 清单时按 slug 回填 cache 明示的真实 context_window,不再退回 272k 兜底', () => {
    // 首次加载:cache 明示 luna 1.1M(verified)。之后「刷新模型信息」走 live,协议不带窗口。
    const cache = mapCodexModelsToCatalog({
      models: [
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_in_api: true, context_window: 1_100_000, priority: 3, supported_reasoning_levels: [{ effort: 'high' }] },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true, context_window: 272000, priority: 7, supported_reasoning_levels: [{ effort: 'high' }] },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', visibility: 'list', supported_in_api: true, context_window: 128000, priority: 23, supported_reasoning_levels: [{ effort: 'high' }] },
        // cache 里有、live 已下架:不得凭 cache 复活
        { slug: 'gpt-retired', display_name: 'Retired', visibility: 'list', supported_in_api: true, context_window: 400000, priority: 30, supported_reasoning_levels: [{ effort: 'high' }] },
      ],
    });
    const live = mapCodexAppServerModelsToCatalog([
      liveItem('gpt-5.6-luna', 'GPT-5.6-Luna'),
      liveItem('gpt-5.5', 'GPT-5.5'),
      liveItem('gpt-5.4-mini', 'GPT-5.4 Mini'),
      // live 新上、cache 还没落盘的模型:保留 272k 兜底且不标 verified
      liveItem('gpt-5.7', 'GPT-5.7'),
    ]);

    const merged = mergeCodexLiveModelsWithCache(live, cache);

    // 成员与顺序以 live 为准(含 live 的 sortOrder 锚点),cache 独有的模型不复活
    expect(merged.map((m) => m.id)).toEqual(['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.7']);
    expect(merged.map((m) => m.sortOrder)).toEqual(live.map((m) => m.sortOrder));
    // 真实窗口回填:1.1M 不再变 272k;更小的 128k 同样照搬(窗口以数据源为准,不做"只升不降")
    expect(merged[0]).toMatchObject({ contextWindow: 1_100_000, contextWindowVerified: true });
    expect(merged[1]).toMatchObject({ contextWindow: 272_000, contextWindowVerified: true });
    expect(merged[2]).toMatchObject({ contextWindow: 128_000, contextWindowVerified: true });
    // live 独有:仍是兜底值,不得被标成已核实
    expect(merged[3].contextWindow).toBe(272_000);
    expect(merged[3].contextWindowVerified).toBeUndefined();
    // 其余能力字段仍来自 live(effort 白名单等),不被 cache 覆盖
    expect(merged[0].efforts).toEqual(live[0].efforts);
    expect(merged[0].defaultEnabled).toBe(true);
  });

  it('cache 缺失 / 为空 / 没有明示窗口时原样返回 live 快照', () => {
    const live = mapCodexAppServerModelsToCatalog([liveItem('gpt-5.6-luna', 'GPT-5.6-Luna')]);
    expect(mergeCodexLiveModelsWithCache(live, null)).toBe(live);
    expect(mergeCodexLiveModelsWithCache(live, [])).toBe(live);
    // cache 条目没标 verified(例如 cache 也缺 context_window 只给了 272k 兜底)→ 不回填
    const unverifiedCache = mapCodexModelsToCatalog({
      models: [{ slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_in_api: true, supported_reasoning_levels: [{ effort: 'high' }] }],
    });
    expect(unverifiedCache[0].contextWindowVerified).toBeUndefined();
    expect(mergeCodexLiveModelsWithCache(live, unverifiedCache)).toBe(live);
  });
});

describe('createCodexLiveModelsPublisher (#4087 review: 异步读 cache 后的新鲜度与读取上限)', () => {
  const liveItem = (slug: string): CodexModelListItem =>
    ({
      id: slug, model: slug, displayName: slug, description: '', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }],
      defaultReasoningEffort: 'high', additionalSpeedTiers: [], serviceTiers: [], isDefault: false,
    }) as CodexModelListItem;
  const verifiedCache = mapCodexModelsToCatalog({
    models: [{ slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_in_api: true, context_window: 1_100_000, supported_reasoning_levels: [{ effort: 'high' }] }],
  });
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('正常路径:读到 cache 即发布回填后的快照', async () => {
    const publish = vi.fn();
    let epoch = 7;
    const publisher = createCodexLiveModelsPublisher({
      readCache: async () => verifiedCache,
      publish,
      authEpoch: () => epoch,
    });
    await publisher([liveItem('gpt-5.6-luna'), liveItem('gpt-5.5')]);
    expect(publish).toHaveBeenCalledOnce();
    const published = publish.mock.calls[0][0] as ReturnType<typeof mapCodexAppServerModelsToCatalog>;
    expect(published.map((m) => [m.id, m.contextWindow, m.contextWindowVerified])).toEqual([
      ['gpt-5.6-luna', 1_100_000, true],
      ['gpt-5.5', 272_000, undefined],
    ]);
  });

  it('读 cache 期间鉴权代次变化(登出/换号/凭证失效)→ 丢弃本次 live 清单,不发布旧账号模型', async () => {
    const publish = vi.fn();
    const log = { info: vi.fn() };
    let epoch = 1;
    const read = deferred<null>();
    const publisher = createCodexLiveModelsPublisher({
      readCache: () => read.promise,
      publish,
      authEpoch: () => epoch,
      log,
    });
    const pending = publisher([liveItem('gpt-5.6-luna')]);
    epoch = 2; // 账号收口:refreshDiscoveredCodexModels 已清空目录
    read.resolve(null);
    await pending;
    expect(publish).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('auth boundary changed'),
      expect.objectContaining({ epoch: 1, current: 2 }),
    );
  });

  it('并发回调:只有最后进入的清单会发布,较旧的清单即使后完成也不覆盖', async () => {
    const publish = vi.fn();
    const first = deferred<null>();
    const second = deferred<null>();
    const reads = [first.promise, second.promise];
    const publisher = createCodexLiveModelsPublisher({
      readCache: () => reads.shift() ?? Promise.resolve(null),
      publish,
      authEpoch: () => 1,
    });
    const older = publisher([liveItem('gpt-old')]);
    const newer = publisher([liveItem('gpt-new')]);
    // 新的先完成 → 发布;旧的后完成 → 序号已过期,丢弃
    second.resolve(null);
    await newer;
    first.resolve(null);
    await older;
    expect(publish).toHaveBeenCalledOnce();
    expect((publish.mock.calls[0][0] as { id: string }[]).map((m) => m.id)).toEqual(['gpt-new']);
  });

  it('cache 读取超时 → 在独立上限内原样发布 live 快照,不拖累 model/list 的 deadline', async () => {
    vi.useFakeTimers();
    try {
      const publish = vi.fn();
      const publisher = createCodexLiveModelsPublisher({
        readCache: () => new Promise(() => {}), // 永不返回:模拟文件系统卡住
        publish,
        authEpoch: () => 1,
        cacheReadTimeoutMs: 100,
      });
      const pending = publisher([liveItem('gpt-5.6-luna')]);
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(publish).toHaveBeenCalledOnce();
      expect((publish.mock.calls[0][0] as { contextWindow: number }[])[0].contextWindow).toBe(272_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('readCodexDiscoveredModelsBounded:读取抛错也归一为 null,不让回填决定刷新成败', async () => {
    await expect(
      readCodexDiscoveredModelsBounded(() => Promise.reject(new Error('EIO')), 50),
    ).resolves.toBeNull();
    await expect(
      readCodexDiscoveredModelsBounded(async () => verifiedCache, 50),
    ).resolves.toBe(verifiedCache);
  });

  it('bumpCodexDiscoveryAuthEpoch 单调递增并可读回', () => {
    const before = getCodexDiscoveryAuthEpoch();
    expect(bumpCodexDiscoveryAuthEpoch()).toBe(before + 1);
    expect(getCodexDiscoveryAuthEpoch()).toBe(before + 1);
  });
});

describe('readCodexDiscoveredModels', () => {
  beforeEach(() => {
    vi.mocked(fsp.readFile).mockReset();
  });

  it('已登录但 XDMaker 自管 cache 不可读时返回 null,让调用方决定保留或清空', async () => {
    vi.mocked(fsp.readFile)
      .mockResolvedValueOnce(OAUTH_AUTH)
      .mockRejectedValueOnce(new Error('missing'));
    await expect(readCodexDiscoveredModels()).resolves.toBeNull();
  });

  it('结构有效的空 cache 返回 [],与读取失败区分', async () => {
    vi.mocked(fsp.readFile)
      .mockResolvedValueOnce(OAUTH_AUTH)
      .mockResolvedValueOnce(JSON.stringify({ models: [] }));
    await expect(readCodexDiscoveredModels()).resolves.toEqual([]);
  });

  it('没有 XDMaker OAuth 时忽略结构有效的旧 cache,不把上一账号模型重新发布', async () => {
    vi.mocked(fsp.readFile)
      .mockRejectedValueOnce(new Error('auth missing'))
      .mockResolvedValueOnce(JSON.stringify(SAMPLE));

    await expect(readCodexDiscoveredModels()).resolves.toEqual([]);
    expect(fsp.readFile).toHaveBeenCalledTimes(1);
  });
});

describe('readCodexDiscoveredModelsForAuthRefresh', () => {
  it('鉴权边界 cache miss / 读取异常都清成空快照,不沿用上一账号模型', async () => {
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockResolvedValue(null)),
    ).resolves.toEqual([]);
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockRejectedValue(new Error('locked'))),
    ).resolves.toEqual([]);
  });

  it('鉴权边界读到有效快照时原样交给 active-catalog', async () => {
    const discovered = mapCodexModelsToCatalog(SAMPLE);
    await expect(
      readCodexDiscoveredModelsForAuthRefresh(vi.fn().mockResolvedValue(discovered)),
    ).resolves.toBe(discovered);
  });
});
