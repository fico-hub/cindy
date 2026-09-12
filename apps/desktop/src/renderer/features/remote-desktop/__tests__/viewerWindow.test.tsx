// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { RemoteDesktopViewerWindow } from '../RemoteDesktopViewerWindow';
import type { ViewerSnapshot } from '../viewerController';

const lifecycle = vi.hoisted(() => ({
  created: vi.fn(),
  disposed: vi.fn(),
  update: null as ((state: ViewerSnapshot) => void) | null,
}));
vi.mock('../viewerController', () => ({
  DesktopViewerController: class {
    constructor(_api: unknown, _root: HTMLElement, update: typeof lifecycle.update) {
      lifecycle.created();
      lifecycle.update = update;
    }
    dispose = lifecycle.disposed;
  },
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => ({ isMac: true, isFullscreen: false }),
}));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  ['direct', '电脑直连'],
  ['relay', '服务器视频中转'],
  ['screenshots', '服务器截图中转'],
] as const)('shows %s beside control status in the toolbar', async (transport, label) => {
  await i18n.changeLanguage('zh-CN');
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onLocale: () => () => {},
        state: async () => ({ generation: 1 }),
        rendererReady: async () => {},
        presentationReady: async () => {},
      },
    },
  });
  const view = render(<RemoteDesktopViewerWindow />);
  await act(async () =>
    lifecycle.update?.({
      target: null,
      ready: true,
      controlling: true,
      status: 'live',
      error: null,
      caps: null,
      displayId: 'one',
      transport,
      latency: null,
      settings: { fps: 30, bitrate: 0, audio: false },
    }),
  );
  const toolbar = within(view.container.querySelector('header')!);
  expect(toolbar.getByText('正在控制')).toBeDefined();
  expect(toolbar.getByText(label)).toBeDefined();
});

it('updates translated controls without ending or recreating the viewer connection', async () => {
  await i18n.changeLanguage('en');
  const listeners = new Set<(locale: string) => void>();
  const rendererReady = vi.fn(async () => {});
  Object.assign(window, {
    electronAPI: {
      remoteDesktopViewer: {
        onActive: () => () => {},
        onLocale: (listener: (locale: string) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        state: async () => ({ generation: 1 }),
        rendererReady,
        presentationReady: async () => {},
      },
    },
  });
  const view = render(<RemoteDesktopViewerWindow />);
  expect(lifecycle.created).toHaveBeenCalledOnce();
  await act(async () => {
    for (const listener of [...listeners]) listener('zh-CN');
  });
  expect(screen.getByRole('button', { name: '操作' })).toBeDefined();
  expect(lifecycle.disposed).not.toHaveBeenCalled();
  expect(lifecycle.created).toHaveBeenCalledOnce();
  expect(rendererReady).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(1);
  view.unmount();
  expect(lifecycle.disposed).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
});
