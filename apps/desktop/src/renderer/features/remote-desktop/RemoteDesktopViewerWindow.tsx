import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Maximize2,
  Minimize2,
  Volume2,
  VolumeX,
  Settings2,
  LogOut,
  Monitor,
  Clipboard,
  Eye,
  MousePointer2,
} from 'lucide-react';
import type { RemoteDesktopDisplayMode } from '@cindy/device-link';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import i18n from '@/i18n';
import { DesktopViewerController, type ViewerSnapshot } from './viewerController';

/** A clean, standalone remote desktop surface. No App, router, agent or task providers. */
export function RemoteDesktopViewerWindow() {
  const { t } = useTranslation();
  const { isMac, isFullscreen } = useMacFullscreen();
  const api = window.electronAPI.remoteDesktopViewer;
  const root = useRef<HTMLDivElement>(null),
    controller = useRef<DesktopViewerController | null>(null);
  const [state, setState] = useState<ViewerSnapshot | null>(null);
  const [settings, setSettings] = useState(false),
    [notice, setNotice] = useState<string | null>(null),
    [clipboardBusy, setClipboardBusy] = useState(false);
  const [modes, setModes] = useState<RemoteDesktopDisplayMode[]>([]);
  const generation = useRef(-1);
  useEffect(() => {
    if (!root.current) return;
    controller.current = new DesktopViewerController(api, root.current, setState);
    const off = api.onActive((value) => {
      generation.current = value.generation;
      if (!value.active) {
        setSettings(false);
        setNotice(null);
        setModes([]);
        setClipboardBusy(false);
        (document.activeElement as HTMLElement | null)?.blur();
      }
    });
    const locale = api.onLocale((value) => {
      // useTranslation's i18n wrapper changes with the locale. Keep the
      // connection lifetime independent of that presentation-only update.
      void i18n.changeLanguage(value);
    });
    const blur = () => {
      controller.current?.releaseInput();
      void api.inputFocus(generation.current, false).catch(() => {});
    };
    const focus = (event: FocusEvent) => {
      void api
        .inputFocus(generation.current, (event.target as HTMLElement)?.id === 'keyboard-input')
        .catch(() => {});
    };
    document.addEventListener('focusin', focus);
    window.addEventListener('blur', blur);
    void api
      .state()
      .then((value) => {
        generation.current = Math.max(generation.current, value.generation);
      })
      .catch(() => {});
    // The quiet connecting shell is renderable content; network setup never gates opening the window.
    void api
      .rendererReady()
      .then(() => api.presentationReady())
      .catch(() => {});
    return () => {
      off();
      locale();
      document.removeEventListener('focusin', focus);
      window.removeEventListener('blur', blur);
      controller.current?.dispose();
      controller.current = null;
    };
  }, [api]);
  const clipboard = async (action: 'copy' | 'paste') => {
    if (clipboardBusy) return;
    setClipboardBusy(true);
    setNotice(null);
    const current = generation.current;
    try {
      await controller.current?.clipboard(action);
      if (current === generation.current) setNotice(t('remoteDesktop.viewer.clipboardDone'));
    } catch {
      if (current === generation.current) setNotice(t('remoteDesktop.viewer.clipboardFailed'));
    } finally {
      if (current === generation.current) setClipboardBusy(false);
    }
  };
  const toggleSettings = () => {
    controller.current?.releaseInput();
    setSettings((value) => !value);
    if (state?.caps?.displayModes)
      void controller.current
        ?.displayModes()
        .then(setModes)
        .catch(() => setModes([]));
  };
  const action = 'remote-viewer-action';
  return (
    <div className={`remote-viewer-window ${isFullscreen ? 'remote-viewer-fullscreen' : ''}`}>
      <header
        className="remote-viewer-toolbar"
        style={{ paddingLeft: isMac && !isFullscreen ? 82 : 12 }}
      >
        <Monitor size={16} />
        <span className="remote-viewer-title">
          {state?.target?.name ?? t('remoteDesktop.title')}
        </span>
        <span className="remote-viewer-status">
          {state?.ready
            ? t(state.controlling ? 'remoteDesktop.controlling' : 'remoteDesktop.viewOnly')
            : t('remoteDesktop.connecting')}
        </span>
        {(state?.caps?.displays.length ?? 0) > 1 && (
          <select
            aria-label={t('remoteDesktop.display')}
            value={state?.displayId}
            onChange={(e) => controller.current?.selectDisplay(e.target.value)}
          >
            {state?.caps?.displays.map((display) => (
              <option key={display.id} value={display.id}>
                {display.name}
              </option>
            ))}
          </select>
        )}
        <button
          className={action}
          disabled={!state?.ready || !state.caps?.canControl}
          title={t(
            state?.controlling ? 'remoteDesktop.releaseControl' : 'remoteDesktop.takeControl',
          )}
          aria-label={t(
            state?.controlling ? 'remoteDesktop.releaseControl' : 'remoteDesktop.takeControl',
          )}
          onClick={() => void controller.current?.setControl(!state?.controlling)}
        >
          {state?.controlling ? <MousePointer2 size={16} /> : <Eye size={16} />}
        </button>
        {state?.caps?.systemAudio && (
          <button
            className={action}
            aria-label={t('remoteDesktop.viewer.sound')}
            aria-pressed={state.settings.audio}
            onClick={() => controller.current?.settings({ audio: !state.settings.audio })}
          >
            {state.settings.audio ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        )}
        <button
          className={action}
          aria-label={t(
            isFullscreen
              ? 'remoteDesktop.viewer.exitFullscreen'
              : 'remoteDesktop.viewer.fullscreen',
          )}
          onClick={() => void api.fullscreen()}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          className={action}
          aria-label={t('remoteDesktop.viewer.settings')}
          aria-expanded={settings}
          onClick={toggleSettings}
        >
          <Settings2 size={16} />
        </button>
        <button
          className={action}
          aria-label={t('remoteDesktop.disconnect')}
          onClick={() => void api.close()}
        >
          <LogOut size={16} />
        </button>
        {!isMac && <WindowControls onClose={() => api.close()} />}
      </header>
      <div ref={root} className="remote-viewer-content">
        <div id="stage" tabIndex={0} aria-label={t('remoteDesktop.title')}>
          <img id="image" alt="" />
          <video id="video" autoPlay muted playsInline />
          <div id="cursor">
            <img id="cursor-image" alt="" />
          </div>
        </div>
        <textarea
          id="keyboard-input"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={t('remoteDesktop.viewer.inputHint')}
        />
        <div id="mouse-buttons" hidden>
          <button id="mouse-left" />
          <button id="mouse-right" />
          <button id="mouse-wheel">
            <span id="mouse-wheel-grip" />
          </button>
        </div>
        {(!state?.ready || state?.error || state?.status === 'reconnecting') && (
          <div className="remote-viewer-connection" role="status">
            <span>
              {state?.error
                ? t(
                    state.error === 'connectionBusy' && state.caps?.connectionTakeover
                      ? 'remoteDesktop.connectionBusyTakeover'
                      : `remoteDesktop.${state.error}`,
                  )
                : t(
                    state?.status === 'reconnecting'
                      ? 'remoteDesktop.reconnecting'
                      : 'remoteDesktop.connecting',
                  )}
            </span>
            {state?.error && (
              <button className={action} onClick={() => controller.current?.retry()}>
                {t(
                  state.error === 'connectionBusy' && state.caps?.connectionTakeover
                    ? 'remoteDesktop.takeoverConnection'
                    : 'remoteDesktop.connect',
                )}
              </button>
            )}
            {state?.error === 'permissionHint' && <button className={action} onClick={() => {
              void controller.current?.permissionGuide().then(() => setNotice(t('remoteDesktop.permissionGuideOpened')))
                .catch(() => setNotice(t('remoteDesktop.permissionActionFailed')));
              setSettings(true);
            }}>{t('remoteDesktop.openGuideOnComputer')}</button>}
          </div>
        )}
        {state?.ready && (
          <div className="remote-viewer-network">
            {state.transport === 'screenshots'
              ? t('remoteDesktop.compatibility')
              : state.transport === 'relay'
                ? t('remoteDesktop.viewer.relay')
                : state.transport === 'direct'
                  ? t('remoteDesktop.viewer.direct')
                  : t('remoteDesktop.live')}
            {state.latency !== null ? ` · ${Math.round(state.latency)} ms` : ''}
          </div>
        )}
      </div>
      {settings && (
        <aside className="remote-viewer-settings" aria-label={t('remoteDesktop.viewer.settings')}>
          <div className="flex items-center justify-between">
            <strong>{t('remoteDesktop.viewer.settings')}</strong>
            <button className={action} onClick={() => setSettings(false)}>
              {t('remoteDesktop.closePermissionGuide')}
            </button>
          </div>
          <button className={action} onClick={() => controller.current?.fit()}>
            {t('remoteDesktop.fit')}
          </button>
          {state?.caps?.videoSettings && (
            <>
              <label>
                {t('remoteDesktop.viewer.fps')}
                <select
                  value={state.settings.fps}
                  onChange={(e) =>
                    controller.current?.settings({ fps: Number(e.target.value) as 30 | 60 })
                  }
                >
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </label>
              <label>
                {t('remoteDesktop.viewer.quality')}
                <select
                  value={state.settings.bitrate}
                  onChange={(e) =>
                    controller.current?.settings({
                      bitrate: Number(e.target.value) as 0 | 2000000 | 8000000 | 20000000,
                    })
                  }
                >
                  {[0, 2000000, 8000000, 20000000].map((value, index) => (
                    <option key={value} value={value}>
                      {t(
                        `remoteDesktop.viewer.${['automatic', 'smooth', 'balanced', 'clear'][index]}`,
                      )}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {modes.length > 0 && (
            <label>
              {t('remoteDesktop.viewer.resolution')}
              <select
                disabled={!state?.controlling}
                value={modes.find((mode) => mode.current)?.id ?? ''}
                onChange={(e) =>
                  void controller.current
                    ?.resolution(e.target.value)
                    .then(() => setModes([]))
                    .catch(() => setNotice(t('remoteDesktop.viewer.settingsFailed')))
                }
              >
                {modes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.width} × {mode.height}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state?.caps?.clipboardText && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2">
                <Clipboard size={16} />
                {t('remoteDesktop.viewer.clipboard')}
              </span>
              <button
                className={action}
                disabled={!state.controlling || clipboardBusy}
                onClick={() => void clipboard('copy')}
              >
                {t('remoteDesktop.viewer.copy')}
              </button>
              <button
                className={action}
                disabled={!state.controlling || clipboardBusy}
                onClick={() => void clipboard('paste')}
              >
                {t('remoteDesktop.viewer.paste')}
              </button>
            </div>
          )}
          <button
            className={action}
            disabled={!state?.controlling}
            onClick={() =>
              controller.current?.keys(
                state?.caps?.platform === 'darwin' ? ['MetaLeft', 'F3'] : ['MetaLeft', 'KeyD'],
              )
            }
          >
            {t('remoteDesktop.showDesktop')}
          </button>
          <button
            className={action}
            disabled={!state?.controlling}
            onClick={() =>
              controller.current?.keys(
                state?.caps?.platform === 'darwin'
                  ? ['ControlLeft', 'ArrowUp']
                  : ['MetaLeft', 'Tab'],
              )
            }
          >
            {t('remoteDesktop.allWindows')}
          </button>
          <p>{t('remoteDesktop.viewer.inputHint')}</p>
          {state?.caps?.displayModes && <p>{t('remoteDesktop.viewer.resolutionHint')}</p>}
          {notice && <p role="status">{notice}</p>}
        </aside>
      )}
    </div>
  );
}
