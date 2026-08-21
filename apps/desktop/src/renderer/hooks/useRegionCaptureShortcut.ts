import { useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';

import { NEW_MAKER_DRAFT_KEY } from '../features/cc-agent/newMakerDraftKeys';
import { resolveAgentIslandVisibleSessionIdFromPath } from '../lib/agentIslandVisibleSessionRoute';
import {
  captureDraftDiscardToken,
  getDraft,
  isDraftDiscardTokenCurrent,
  saveDraft,
  subscribeDraft,
} from '../lib/composerDraftStore';
import type { AttachedFile } from '../lib/fileTypes';
import { useAppShortcut } from './useAppShortcut';

/**
 * capture-region 快捷键的全局消费端 —— 只在 MainLayout 挂载一次。
 *
 * 单点注册 + 触发时按当前路由解析目标, 而不是挂在各个 attachmentState owner
 * 上: CCAgentSessionView 会多实例共存(分屏各 pane、RSB 协作 tab 隐藏保挂、
 * 文档栏收起保挂), 分散注册会让先注册的隐藏实例抢占按键、把截图贴进错误
 * 会话(review P1)。
 *
 * 完成后直接写 composerDraftStore(ImageLightbox「发送到对话」同款合并), 不走
 * mounted attachmentState: 系统选区期间用户可能切走路由, owner 卸载后其
 * addClipboardImage 的 scope 守卫会把结果静默丢弃(review P1)。draft store 与
 * 挂载无关, 挂载中的 ChatInput/useAttachments 经订阅自动刷新。
 *
 * 返回 trigger 供菜单命令通道复用(webview guest 聚焦时 main 侧转发
 * app-menu:command 'capture-region' 到 MainLayout, 见 main/webview-security)。
 * 非 darwin 下 registry 平台过滤让生效组合为空, 快捷键监听不命中; guest 转发
 * 同样以生效组合为门, 无需再判平台。
 */

export interface RegionCaptureTarget {
  /** 会话路由时为会话 id; 新任务草稿(/cc-agent/new)时为 null(无会话目录, 附件走 base64)。 */
  sessionId: string | null;
  /** composerDraftStore 的 scope key(会话 id 或 NEW_MAKER_DRAFT_KEY)。 */
  draftKey: string;
}

/**
 * 主内容区当前 composer 的归属; 无 composer 的路由(设置/文档浏览等)返回
 * null, 触发端据此不消费按键。纯函数, 供单测直接断言。
 */
export function resolveRegionCaptureTargetFromPath(pathname: string): RegionCaptureTarget | null {
  if (pathname === '/cc-agent/new') {
    return { sessionId: null, draftKey: NEW_MAKER_DRAFT_KEY };
  }
  const sessionId = resolveAgentIslandVisibleSessionIdFromPath(pathname);
  if (sessionId) {
    return { sessionId, draftKey: sessionId };
  }
  return null;
}

/** Uint8Array → base64(草稿态无会话目录时的附件形态, 与 useAttachments F6 fallback 对齐)。 */
function bytesToBase64(data: Uint8Array): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data as BlobPart], { type: 'image/png' }));
  });
}

/**
 * 截图字节 → AttachedFile → 合并进目标草稿(保留既有正文/附件/评论与一次性
 * handoff 字段)。isTargetStillValid 在 saveDraft 前的最后时刻复查 —— 附件
 * 缓存写入本身也是异步, 期间草稿可能被发送/丢弃。
 */
async function appendRegionCaptureToDraft(
  target: RegionCaptureTarget,
  data: Uint8Array,
  isTargetStillValid: () => boolean,
): Promise<void> {
  const timestamp = Date.now();
  const name = `region-capture-${timestamp}.png`;
  const base = {
    id: crypto.randomUUID(),
    name,
    path: `clipboard://region-capture-${timestamp}`,
    ext: '.png',
    size: data.byteLength,
    category: 'image' as const,
    mimeType: 'image/png',
    originalName: name,
  };
  let attached: AttachedFile;
  if (target.sessionId) {
    try {
      const cached = await window.electronAPI.cacheImageFromBuffer({
        sessionId: target.sessionId,
        buffer: data,
        mimeType: 'image/png',
        suggestedName: name,
      });
      attached = { ...base, url: cached.url };
    } catch {
      attached = { ...base, base64: await bytesToBase64(data) };
    }
  } else {
    attached = { ...base, base64: await bytesToBase64(data) };
  }
  if (!isTargetStillValid()) return;
  const existing = getDraft(target.draftKey);
  saveDraft(
    target.draftKey,
    {
      ...existing,
      text: existing?.text ?? null,
      attachments: [...(existing?.attachments ?? []), attached],
      quotes: existing?.quotes ?? [],
      browserComments: existing?.browserComments ?? [],
    },
    { preserveRemoteOptimisticRecovery: true },
  );
}

export function useRegionCaptureShortcut(): () => boolean {
  const location = useLocation();
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;

  const trigger = useCallback((): boolean => {
    // 目标在按键瞬间定格: 系统选区期间切路由不改变归属, 结果仍进当初的草稿。
    const target = resolveRegionCaptureTargetFromPath(pathnameRef.current);
    if (!target) return false;
    // 迟到结果的写入闸(两个信号任一命中即丢弃, 不回填已易主/已丢弃的草稿):
    // 1. discard token —— 显式丢弃(discardDraft)会 bump generation;
    // 2. 新任务草稿的发送 handoff —— 发送走 clearDraftAndNotify(有意不 bump
    //    generation, 见 store 注释), 但会以"显式空草稿"通知订阅者; 选区期间
    //    观察到空草稿通知 = 草稿已随发送交给新会话, 迟到截图若仍回填会出现
    //    在用户下一次打开的新任务草稿里。会话草稿不做此检测: 发送后仍留在
    //    同一会话, 迟到附件按 store 语义属于下一条消息的输入。
    const discardToken = captureDraftDiscardToken(target.draftKey);
    let draftHandedOff = false;
    const unsubscribe = target.sessionId
      ? null
      : subscribeDraft(target.draftKey, () => {
          const draft = getDraft(target.draftKey);
          if (!draft || (!draft.text && draft.attachments.length === 0)) {
            draftHandedOff = true;
          }
        });
    const isTargetStillValid = () => !draftHandedOff && isDraftDiscardTokenCurrent(discardToken);
    void (async () => {
      try {
        const result = await window.electronAPI.screenCapture.captureRegion();
        if (result.cancelled || !result.data) return;
        if (!isTargetStillValid()) return;
        await appendRegionCaptureToDraft(target, result.data, isTargetStillValid);
      } catch (err) {
        console.warn('[useRegionCaptureShortcut] region capture failed', err);
      } finally {
        unsubscribe?.();
      }
    })();
    return true;
  }, []);

  useAppShortcut('capture-region', trigger);
  return trigger;
}
