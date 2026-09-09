// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import { ProjectsSection, type ProjectsSectionProps } from '../features/cc-agent/sidebar/sections/ProjectsSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({ useEffectiveSelectedMachineId: () => 'all' }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/hooks/useSidebarCardMode', () => ({ useSidebarMainViewMode: () => ({ mode: 'text' }) }));
vi.mock('../features/cc-agent/hooks/useRemoteHostProjectOrders', () => ({
  projectOrderWriteScopeForSelection: () => ({ kind: 'viewer' }),
  useLocalHostProjectOrder: () => ({ snapshot: { manualProjectOrder: [] } }),
  useRemoteHostProjectOrders: () => ({ orders: new Map() }),
}));
vi.mock('../features/cc-agent/sidebar/MainListScopeHeader', () => ({ MainListScopeHeader: () => null }));
vi.mock('@/components/sidebar/SortableList', () => ({ SortableList: () => null }));
vi.mock('../features/cc-agent/sidebar/sections/ProjectNode', () => ({ ProjectNode: () => null }));
vi.mock('../features/cc-agent/sidebar/sections/UnclassifiedSection', () => ({ UnclassifiedSection: () => null }));
vi.mock('@/features/bots/BotAvatar', () => ({ BotAvatar: () => <span>Bot avatar</span> }));
// Keep ProjectsSection, its private SessionGroupNode, SessionEntryList, collapse model,
// lamp aggregation and remote store real. Only unrelated services/leaf rows are stubbed.
vi.mock('../features/cc-agent/sidebar/SessionItem', () => ({
  SessionItem: ({ session }: { session: Session }) => <div data-testid={`row-${session.id}`}>{session.title}</div>,
}));
vi.mock('../features/cc-agent/sidebar/SessionCard', () => ({ SessionCard: () => null }));
vi.mock('../features/cc-agent/sidebar/AutomationSessionGroupItem', () => ({ AutomationSessionGroupItem: () => null }));

function props(groupDevice: boolean): ProjectsSectionProps {
  const sessions = ['first', 'idle', 'lit'].map((id, i) => ({
    id, title: id, status: 'active', createdAt: `2026-09-0${3 - i}T00:00:00Z`,
    updatedAt: `2026-09-0${3 - i}T00:00:00Z`, deviceLinkDeviceId: 'remote',
  } as Session));
  return {
    unclassified: [], projects: [], dialogues: [], allKnownProjects: [], allProjectKeysForOrder: ['local:known-project'],
    bots: [{ botId: 'demo', displayName: 'Demo Bot', avatar: '', avatarColor: '', sessions, latestActivityAt: sessions[0].updatedAt }],
    filter: {
      groupBy: 'project', groupDialogue: true, groupDevice, sortBy: 'recency',
      projectOrder: 'activity', manualProjectOrder: [], projects: 'all', status: 'active', isFilterActive: false,
      projectsAsSet: null, isSessionContentFiltered: false, vendor: 'all', lastActivity: 'all', manualPinnedOrder: [],
      setStatus: vi.fn(), toggleProject: vi.fn(), ensureProjectIncluded: vi.fn(), setProjectsAll: vi.fn(), gc: vi.fn(),
      setVendor: vi.fn(), setLastActivity: vi.fn(), setGroupBy: vi.fn(), setGroupDialogue: vi.fn(), setGroupDevice: vi.fn(),
      setSortBy: vi.fn(), setProjectOrder: vi.fn(), resetContentFilters: vi.fn(), setManualProjectOrder: vi.fn(),
      setManualPinnedOrder: vi.fn(), promotePin: vi.fn(), removePin: vi.fn(),
    },
    collapsed: new Set(), isAllCollapsed: false, runningSessionIds: new Set(), attachedSessionIds: new Set(),
    notifications: new Set(), scheduleSessionIndex: new Map(),
    remoteDeviceIndex: new Map([['remote', { name: 'Remote device', online: true }]]),
    onSessionClick: vi.fn(), onAction: vi.fn(), onRename: vi.fn(), onTogglePin: vi.fn(), onScheduleAction: vi.fn(),
    onToggleProject: vi.fn(), onToggleProjectPin: vi.fn(), onRenameProject: vi.fn(), onRemoveFromSidebar: vi.fn(),
    onCollapseAll: vi.fn(), onExpandAll: vi.fn(), onCreateInProject: vi.fn(), onOpenConversationSearch: vi.fn(),
    onOpenInExplorer: vi.fn(), onLinkCodexProject: vi.fn(), linkingCodexProject: null, onBrowseFiles: vi.fn(),
    onArchiveAll: vi.fn(), onCreateDialogue: vi.fn(),
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sidebar.collapse.projectSessionLimit', '1');
});
afterEach(() => { cleanup(); clearRemoteSessionActivity(); localStorage.clear(); });

const phases = ['running', 'needs-interaction', 'error', 'completed'] as const;
function activity(phase: typeof phases[number]) {
  applyRemoteSessionActivity('remote', { sessionId: 'lit', phase, attention: true, compactDetail: '' });
}

describe.each([false, true])('Bot groups with device grouping %s', (groupDevice) => {
  it.each(phases)('renders the Bot header lamp for remote %s', (phase) => {
    activity(phase);
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(Boolean(screen.queryByText('Remote device'))).toBe(groupDevice);
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    if (phase === 'running') {
      expect(header.querySelector('.session-status-breathing')).not.toBeNull();
    } else {
      const tone = phase === 'needs-interaction' ? 'awaiting' : phase === 'error' ? 'error' : 'done';
      expect(header.querySelector(`[class*="--card-status-${tone}"]`)).not.toBeNull();
    }
  });

  it.each(phases)('reveals the remote %s row beyond the group limit without Show all', (phase) => {
    activity(phase);
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(screen.getByTestId('row-first')).toBeTruthy();
    expect(screen.queryByTestId('row-idle')).toBeNull();
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    expect(screen.getByText('ccAgent.sidebar.showAllSessions')).toBeTruthy();
  });

  it('updates the rendered group on remote activity and retains its lamp across collapse/expand', () => {
    render(<ProjectsSection {...props(groupDevice)} />);
    expect(screen.queryByTestId('row-lit')).toBeNull();
    const header = screen.getByText('Demo Bot').closest('[role="button"]')!;
    expect(header.querySelector('.session-status-breathing')).toBeNull();
    act(() => activity('running'));
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.querySelector('.session-status-breathing')).not.toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByTestId('row-lit')).not.toBeNull();
    act(() => clearRemoteSessionActivity());
    expect(screen.queryByTestId('row-lit')).toBeNull();
    expect(header.querySelector('.session-status-breathing')).toBeNull();
  });
});
