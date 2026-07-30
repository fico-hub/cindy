/**
 * im/desktopConfirmNotice.ts — 桌面专属确认卡挂起时的 IM 侧提示(#926)。
 *
 * issue_confirm / rename confirm / ghost_grant_confirm 这类确认卡**有意**只在
 * 桌面端出现(见 issueConfirmBridge 头注:它们不进 agent 的 InteractionRequest
 * union,feishu /ctr 接管路径对未知 kind 会直接 deny)。但飞书驱动的会话里用户
 * 人在 IM 侧,看不到卡片,只能等到 CONFIRM_TIMEOUT 才知道出了事。
 *
 * 这里补的是**不可交互的文字提示**:卡片仍然只在桌面(不动既有设计边界),
 * IM 侧即时收到「有确认卡在桌面等你」。best-effort:提示失败绝不影响确认流程
 * (fire-and-forget,桥不等待、不感知失败)。
 */

import { eq } from 'drizzle-orm';

import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';

const log = createLogger('im-desktop-confirm-notice');

export interface DesktopConfirmNoticeDeps {
  /** 会话绑定的飞书 openId;非飞书会话返回 null(桌面本来就是唯一交互面)。 */
  getFeishuOpenId(sessionId: string): Promise<string | null>;
  sendFeishuText(openId: string, markdown: string): Promise<unknown>;
  logWarn?(message: string): void;
}

/** 提示文案(纯函数,便于单测锚定)。 */
export function buildDesktopConfirmNoticeText(what: string): string {
  return `🔔 ${what}正在桌面端 Cindy 等待你的确认;超时将自动取消,如需继续请到桌面端操作。`;
}

/**
 * 组装 fire-and-forget 通知函数(DI 便于单测;生产接线见
 * createFeishuDesktopConfirmNotifier)。
 */
export function createDesktopConfirmNotifier(
  deps: DesktopConfirmNoticeDeps,
): (sessionId: string, what: string) => void {
  return (sessionId, what) => {
    void (async () => {
      try {
        const openId = await deps.getFeishuOpenId(sessionId);
        if (!openId) return;
        await deps.sendFeishuText(openId, buildDesktopConfirmNoticeText(what));
      } catch (err) {
        deps.logWarn?.(
          `desktop-confirm IM notice failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };
}

/** 生产接线:sessions 表反查 feishuOpenId + 复用 im/host 的 feishuIm 实例。 */
export function createFeishuDesktopConfirmNotifier(): (sessionId: string, what: string) => void {
  return createDesktopConfirmNotifier({
    async getFeishuOpenId(sessionId) {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({ openId: sessions.feishuOpenId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      const openId = row?.openId?.trim();
      return openId ? openId : null;
    },
    async sendFeishuText(openId, markdown) {
      // 动态 import 避免模块加载期就拉起 im/host(它有连接副作用;确认卡可能在
      // IM 从未启用的会话里出现,这时根本走不到 send)。
      const { feishuIm } = await import('./host.js');
      return feishuIm.sendMarkdownText(openId, markdown);
    },
    logWarn: (m) => log.warn(m),
  });
}
