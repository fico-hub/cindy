// @vitest-environment jsdom

/**
 * TodaySpendChip 的 device-link 远程会话形态:
 *   - 显式 anthropic 的远程订阅会话:用被控端镜像快照按本机订阅形态渲染窗口段,
 *     悬停出同款额度卡(chip 不可点 —— 看板属被控端账号,不跳本机浏览器);
 *   - 被控端镜像不可用(老被控端 / 断链):降级回「仅会话金额 / ¥ 占位」;
 *   - 默认路由(providerId=null)的远程会话:不做本机启发式猜测,维持占位显示。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';
import type { SessionUsageMoney } from '@/hooks/useSessionUsageMoney';

const mocks = vi.hoisted(() => ({
  localClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  remoteClaudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  remoteHookDeviceIds: [] as Array<string | null>,
  requestRemoteRefresh: vi.fn(),
  sessionUsage: {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  } as SessionUsageMoney,
  displaySnapshot: {
    messages: [] as Array<Record<string, unknown>>,
  },
  openExternal: vi.fn(() => Promise.resolve()),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      const templates: Record<string, string> = {
        'todaySpend.claude.weeklyLabel': '周限',
        'todaySpend.claude.modelWeeklyLabel': '{{model}} 周限',
        'todaySpend.claude.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.sessionCostLabel': '本任务 {{cost}}',
        'quotaCard.fiveHourLabel': '5 小时',
        'quotaCard.weeklyLabel': '周限',
        'quotaCard.modelWeeklyLabel': '{{model}} 周限',
        'quotaCard.usedPercent': '已用 {{percent}}%',
        'quotaCard.waiting': '等待额度数据',
      };
      return (templates[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
        String(options[name] ?? ''),
      );
    },
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: false, isReconciling: false }),
}));
vi.mock('@/hooks/useClaudeOAuthConnected', () => ({
  useClaudeOAuthConnected: () => null,
}));
vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: () => null,
}));
vi.mock('@/hooks/useSessionUsageMoney', () => ({
  useSessionUsageMoney: () => mocks.sessionUsage,
}));
vi.mock('@/hooks/useSessionTokens', () => ({ useSessionTokens: () => null }));
vi.mock('@/hooks/useAccountUsage', () => ({
  requestCodexAccountRefresh: vi.fn(),
  useAccountUsage: () => null,
}));
vi.mock('@/hooks/useClaudeAccountUsage', () => ({ useClaudeAccountUsage: () => null }));
vi.mock('@/hooks/useModelAccessCreditUsage', () => ({ useModelAccessCreditUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: () => mocks.localClaudeSnapshot,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  requestRemoteClaudeSubscriptionRefresh: mocks.requestRemoteRefresh,
  useRemoteClaudeSubscriptionUsage: (deviceId: string | null) => {
    mocks.remoteHookDeviceIds.push(deviceId);
    return deviceId ? mocks.remoteClaudeSnapshot : null;
  },
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: null }),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({
  useCodexRateLimits: () => ({ snapshot: null, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useXaiRateLimit', () => ({ useXaiRateLimit: () => null }));
vi.mock('@/components/chat/ChatDisplaySnapshotContext', () => ({
  useChatDisplaySnapshot: () => mocks.displaySnapshot,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: () => mocks.displaySnapshot,
    subscribe: () => () => undefined,
  },
}));

import { TodaySpendChip } from '../TodaySpendChip';

function renderRemoteChip(providerId: string | null) {
  return render(
    <TodaySpendChip
      vendorKey="cc"
      providerId={providerId}
      modelId="claude-fable-5[1m]"
      sessionId="session-remote-1"
      deviceLinkDeviceId="device-abc"
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.localClaudeSnapshot = null;
  mocks.remoteClaudeSnapshot = null;
  mocks.remoteHookDeviceIds = [];
  mocks.sessionUsage = {
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  };
  mocks.displaySnapshot.messages = [];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal: mocks.openExternal },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TodaySpendChip device-link remote sessions', () => {
  it('显式 anthropic 远程会话用被控端镜像快照渲染订阅窗口段(与本机形态一致)', () => {
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 25 },
      scoped: [{ modelDisplayName: 'Fable', utilization: 34 }],
    };

    const { container } = renderRemoteChip('anthropic');

    expect(container.textContent).toContain('5h 剩余 88%');
    expect(container.textContent).toContain('Fable 周限 剩余 66%');
    // 远程订阅会话读的是被控端镜像 hook(deviceId 透传),不读本机快照。
    expect(mocks.remoteHookDeviceIds).toContain('device-abc');
  });

  it('远程订阅会话悬停出额度卡,chip 不可点(看板属被控端账号)', () => {
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };

    const { container } = renderRemoteChip('anthropic');

    // 无看板链接 → trigger 是 span 而非 button。
    expect(screen.queryByRole('button')).toBeNull();
    const trigger = container.querySelector('span[tabindex="-1"]');
    expect(trigger?.textContent).toContain('5h 剩余 88%');

    fireEvent.mouseEnter(trigger!);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByTestId('quota-hover-card')).toBeTruthy();
  });

  it('被控端镜像不可用(老被控端 / 断链)时降级回 ¥ 占位', () => {
    mocks.remoteClaudeSnapshot = null;

    const { container } = renderRemoteChip('anthropic');

    expect(container.textContent).not.toContain('剩余');
    // 占位货币符号分区域('¥' / '$'),断言形态不锁定具体符号。
    expect(container.textContent).toMatch(/[¥$]/);
  });

  it('默认路由(providerId=null)的远程会话维持占位显示,不做本机启发式猜测', () => {
    // 即使本机自己连了订阅、有本机快照,也不得替被控端会话渲染本机余量。
    mocks.localClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 12 },
    };
    mocks.remoteClaudeSnapshot = {
      source: 'oauth-endpoint',
      fiveHour: { utilization: 34 },
    };

    const { container } = renderRemoteChip(null);

    expect(container.textContent).not.toContain('剩余');
    // 默认路由远程会话不应启用远程订阅镜像 hook(deviceId 恒为 null)。
    expect(mocks.remoteHookDeviceIds.filter(Boolean)).toHaveLength(0);
  });
});
