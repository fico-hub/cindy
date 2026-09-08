import { describe, expect, it, vi } from 'vitest';
import { createComposerDraftSaveScheduler } from '../../lib/composerDraftSaveScheduler';
import { getDraft, saveDraft, plainTextToTiptapDoc } from '../../lib/composerDraftStore';

import { NEW_MAKER_DRAFT_KEY } from '../../features/cc-agent/newMakerDraftKeys';
import {
  appendRegionCaptureToDraft,
  registerComposerCaptureDraftFlusher,
  getComposerCaptureLockVersion,
  isComposerCaptureLocked,
  registerComposerCaptureLock,
  subscribeComposerCaptureLocks,
  requestRegionCapture,
  resolveRegionCaptureTargetFromPath,
} from '../useRegionCaptureShortcut';

describe('composer capture lock registry', () => {
  // 同一 draftKey 多实例挂载(分屏同会话): 任一实例仍锁定即视为锁定;
  // 解锁按 token 对称, 不误清其它实例的锁。
  it('tracks per-draftKey locks with multi-mount tokens', () => {
    expect(isComposerCaptureLocked('s1')).toBe(false);
    const releaseA = registerComposerCaptureLock('s1');
    const releaseB = registerComposerCaptureLock('s1');
    expect(isComposerCaptureLocked('s1')).toBe(true);
    releaseA();
    expect(isComposerCaptureLocked('s1')).toBe(true);
    releaseB();
    expect(isComposerCaptureLocked('s1')).toBe(false);
    // release 幂等
    releaseB();
    expect(isComposerCaptureLocked('s1')).toBe(false);
    expect(isComposerCaptureLocked('s2')).toBe(false);
  });

  // 锁变更要可订阅: guest 转发的可用性上报随锁变化重报, 否则锁定期间
  // main 仍拦 webview 按键(review P2)。幂等 release 不产生通知。
  it('notifies subscribers on lock changes and bumps the version', () => {
    let notified = 0;
    const unsubscribe = subscribeComposerCaptureLocks(() => {
      notified += 1;
    });
    const before = getComposerCaptureLockVersion();
    const release = registerComposerCaptureLock('s3');
    expect(notified).toBe(1);
    release();
    expect(notified).toBe(2);
    release();
    expect(notified).toBe(2);
    expect(getComposerCaptureLockVersion()).toBe(before + 2);
    unsubscribe();
    registerComposerCaptureLock('s3');
    expect(notified).toBe(2);
  });
});

describe('requestRegionCapture', () => {
  // composer「+」菜单入口在 MainLayout 未注册 trigger 时(理论不可达)安全
  // 返回 false, 不抛错。注册后的行为与快捷键共用同一 trigger, 由 MainLayout
  // 单点注册保证。
  it('safely returns false when no trigger is registered', () => {
    expect(requestRegionCapture()).toBe(false);
  });
});

describe('resolveRegionCaptureTargetFromPath', () => {
  it('session route → that session (draft key = session id)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/abc-123')).toEqual({
      sessionId: 'abc-123',
      draftKey: 'abc-123',
    });
  });

  it('new-maker draft route → NEW_MAKER_DRAFT_KEY, no session id (base64 attachment path)', () => {
    expect(resolveRegionCaptureTargetFromPath('/cc-agent/new')).toEqual({
      sessionId: null,
      draftKey: NEW_MAKER_DRAFT_KEY,
    });
  });

  // 无主内容区 composer 的路由不消费按键(触发端据 null 返回 false, 按键保持
  // 原生行为)。files 段是文档浏览(rail composer 不作为目标, 归属对用户不可
  // 预期); boot/new-dialogue/scheduled 是非会话段。
  it('routes without a main-area composer → null', () => {
    for (const pathname of [
      '/settings',
      '/issues',
      '/cc-agent/files/some-doc',
      '/cc-agent/boot',
      '/cc-agent/new-dialogue',
      '/cc-agent/scheduled',
      '/cc-agent/orca/some-lead',
      '/',
    ]) {
      expect(resolveRegionCaptureTargetFromPath(pathname)).toBeNull();
    }
  });
});


describe('capture pending editor save', () => {
  it('merges after cache completion using the live pending document', async () => {
    const key = 'capture-live-pending';
    const oldText = plainTextToTiptapDoc('before');
    const liveText = plainTextToTiptapDoc('before newly typed');
    saveDraft(key, { text: oldText, attachments: [], quotes: [] }, { silent: true });
    let resolveCache!: (value: { url: string }) => void;
    const cache = new Promise<{ url: string }>((resolve) => { resolveCache = resolve; });
    vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: () => cache } });
    const scheduler = createComposerDraftSaveScheduler({ setTimer: () => 1, clearTimer: () => {} });
    const release = registerComposerCaptureDraftFlusher(key, scheduler.flush);
    const unrelated = vi.fn();
    const releaseOther = registerComposerCaptureDraftFlusher('other-capture-draft', unrelated);
    try {
      const pending = appendRegionCaptureToDraft({ sessionId: key, draftKey: key }, new Uint8Array([1]), () => true);
      scheduler.schedule(() => saveDraft(key, { ...getDraft(key)!, text: liveText }, { silent: true }));
      resolveCache({ url: 'xdt-image://capture.png' });
      await pending;
      expect(getDraft(key)?.text).toEqual(liveText);
      expect(getDraft(key)?.attachments).toHaveLength(1);
      expect(unrelated).not.toHaveBeenCalled();
    } finally {
      release();
      releaseOther();
      scheduler.cancel();
      vi.unstubAllGlobals();
    }
  });
});


it('does not append after a flush invalidates the target', async () => {
  const key = 'capture-invalidated';
  let valid = true;
  vi.stubGlobal('window', { electronAPI: { cacheImageFromBuffer: async () => ({ url: 'xdt-image://capture.png' }) } });
  const release = registerComposerCaptureDraftFlusher(key, () => { valid = false; });
  try {
    await appendRegionCaptureToDraft({ sessionId: key, draftKey: key }, new Uint8Array([1]), () => valid);
    expect(getDraft(key)).toBeUndefined();
  } finally {
    release();
    vi.unstubAllGlobals();
  }
});
