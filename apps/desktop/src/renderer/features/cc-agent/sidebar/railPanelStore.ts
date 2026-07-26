/**
 * railPanelStore — 折叠 rail 二级面板的跨组件状态桥。
 * ---------------------------------------------------------------------------
 * 为什么要一个 store:rail 瓷砖(CollapsedView/RailNav,折叠态可见)与面板内容
 * (RailPanels,由 **ExpandedView** 渲染)不在同一子树 —— 面板行要复用展开态的
 * 全套会话操作(archive 两步确认 / 右键菜单 / 重命名 / 移动 / schedule 操作),
 * 这些 handler 全部长在 ExpandedView 内部且深度耦合其状态;两视图常驻挂载
 * (opacity 互换),portal 面板不受隐藏 wrapper 影响,因此让 ExpandedView 渲染
 * 面板即可**零复制**继承全部行为,永不与展开态漂移。
 *
 * 本 store 只承载「开哪个面板 + 锚点 + 120ms hover 桥接计时」这一点点状态,
 * useSyncExternalStore 消费;快照对象引用稳定,只在变更时整体替换。
 */

export type RailPanelSection = 'projects' | 'dialogues';

export interface RailPanelAnchor {
  right: number;
  top: number;
}

export interface RailPanelState {
  openSection: RailPanelSection | null;
  anchor: RailPanelAnchor | null;
  /** 触发瓷砖元素——RailPanels 用 IntersectionObserver 监测其可见性,
   *  触发器消失(⌘B 完全隐藏 / rail 滚出)即收面板,不依赖指针再动。 */
  anchorEl: HTMLElement | null;
  openProjectKey: string | null;
  projectAnchor: RailPanelAnchor | null;
  /** 灯语取样范围(会话 id):由 RailPanels(ExpandedView)发布,与面板实际
   *  展示的过滤后集合一致(vendor/项目筛选/未分类都算);null = 尚未发布,
   *  RailNav 回落到自身按机器过滤的推导。 */
  lampScope: RailLampScope | null;
}

export interface RailLampScope {
  projectSessionIds: readonly string[];
  dialogueSessionIds: readonly string[];
}

/** hover 桥接:指针离开瓷砖/面板后的收回宽限(与 peek 抽屉同量级)。 */
export const RAIL_PANEL_CLOSE_GRACE_MS = 120;

const CLOSED_FIELDS = {
  openSection: null,
  anchor: null,
  anchorEl: null,
  openProjectKey: null,
  projectAnchor: null,
} as const;

const INITIAL: RailPanelState = { ...CLOSED_FIELDS, lampScope: null };

let state: RailPanelState = INITIAL;
const listeners = new Set<() => void>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let projectCloseTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: RailPanelState): void {
  state = next;
  for (const listener of listeners) listener();
}

function clearCloseTimer(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}
function clearProjectCloseTimer(): void {
  if (projectCloseTimer) { clearTimeout(projectCloseTimer); projectCloseTimer = null; }
}

/** 面板内有**行内编辑焦点**(双击重命名的 input 等)时抑制 hover 宽限收回:
 *  面板不是纯 hover 浮层,编辑期间指针短暂离开不能拆掉编辑器丢用户输入。
 *  只认可编辑元素,不认普通按钮焦点——否则点过行的面板永远不自动收。
 *  显式收回(Esc / 面板外点击 / closeAll)不受此限。 */
export function panelHasEditingFocus(): boolean {
  const ae = typeof document !== 'undefined' ? document.activeElement : null;
  if (!(ae instanceof HTMLElement) || !ae.closest('[data-rail-panel]')) return false;
  return ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable;
}

/** 有阻断性浮层(Radix 菜单/子菜单/选择器/确认弹窗)打开时抑制 hover 宽限收回:
 *  Radix modal 浮层会给 body 挂 pointer-events:none,面板上的指针判定全部失灵——
 *  mouseleave(relatedTarget 不匹配保活白名单)与全局 pointermove(target 退化成
 *  `<html>`)都会误判「指针已离开」,把面板连同刚弹出的菜单一起收掉(实测:行 ⋮
 *  菜单弹出即自动关闭;右键菜单因光标恰好落在菜单内容上而幸免)。浮层关闭后
 *  body 恢复,下一次 pointermove 重新接管收回。tooltip 也挂 popper wrapper,
 *  用 :has 限定菜单/列表内容,不让悬浮提示误阻收回。 */
function panelHasBlockingOverlay(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.querySelector(
      '[data-radix-popper-content-wrapper]:has([role="menu"],[role="listbox"]),[role="dialog"],[role="alertdialog"]',
    ) != null
  );
}

function suppressAutoClose(): boolean {
  return panelHasEditingFocus() || panelHasBlockingOverlay();
}

export const railPanelStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): RailPanelState {
    return state;
  },

  /** 打开(或切换)一级面板;同时收起可能开着的项目二级。 */
  openSection(section: RailPanelSection, anchor: RailPanelAnchor, anchorEl: HTMLElement): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    emit({ ...state, openSection: section, anchor, anchorEl, openProjectKey: null, projectAnchor: null });
  },

  /** 由 RailPanels 发布与面板展示一致的灯语取样范围(浅比较去抖,防循环)。 */
  setLampScope(scope: RailLampScope | null): void {
    const prev = state.lampScope;
    const same =
      (prev == null && scope == null) ||
      (prev != null &&
        scope != null &&
        prev.projectSessionIds.length === scope.projectSessionIds.length &&
        prev.dialogueSessionIds.length === scope.dialogueSessionIds.length &&
        prev.projectSessionIds.every((id, i) => id === scope.projectSessionIds[i]) &&
        prev.dialogueSessionIds.every((id, i) => id === scope.dialogueSessionIds[i]));
    if (same) return;
    emit({ ...state, lampScope: scope });
  },
  /** 项目一级面板内 hover 具体项目 → 打开二级。 */
  openProject(projectKey: string, anchor: RailPanelAnchor): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state.openSection !== 'projects') return;
    emit({ ...state, openProjectKey: projectKey, projectAnchor: anchor });
  },

  cancelClose(): void {
    clearCloseTimer();
  },
  scheduleClose(): void {
    if (suppressAutoClose()) return;
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      // 触发时再验一次:浮层可能在计时器排下之后、走完之前才挂载
      // (点击 ⋮ → mouseleave 先到、菜单内容后 mount 的竞态)。
      if (suppressAutoClose()) return;
      railPanelStore.closeAll();
    }, RAIL_PANEL_CLOSE_GRACE_MS);
  },
  cancelProjectClose(): void {
    clearProjectCloseTimer();
  },
  scheduleProjectClose(): void {
    if (suppressAutoClose()) return;
    clearProjectCloseTimer();
    projectCloseTimer = setTimeout(() => {
      projectCloseTimer = null;
      if (suppressAutoClose()) return;
      if (state.openProjectKey) emit({ ...state, openProjectKey: null, projectAnchor: null });
    }, RAIL_PANEL_CLOSE_GRACE_MS);
  },

  closeAll(): void {
    clearCloseTimer();
    clearProjectCloseTimer();
    if (state.openSection !== null || state.anchorEl !== null) {
      emit({ ...state, ...CLOSED_FIELDS });
    }
  },
};
