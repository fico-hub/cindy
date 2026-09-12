// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { RemoteDesktopViewerWindow } from '../RemoteDesktopViewerWindow';

const lifecycle = vi.hoisted(() => ({ created: vi.fn(), disposed: vi.fn() }));
vi.mock('../viewerController', () => ({
  DesktopViewerController: class {
    constructor() {
      lifecycle.created();
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
