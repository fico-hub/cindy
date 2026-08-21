import { useRef } from 'react';

import { useAppShortcut } from './useAppShortcut';

/**
 * capture-region 快捷键消费端: 调起系统区域截图(main 侧 screencapture -i),
 * 拿回 PNG 字节后复用剪贴板图片粘贴管线(addClipboardImage)进当前 composer
 * 附件。取消(Esc)与进行中去重都静默返回。
 *
 * 挂载点 = attachmentState 的 owner(会话视图 / 新任务草稿路由, 二者互斥路由)。
 * stopImmediate 压制同阶段其它 capture 监听, 防未来共存挂载时重复触发。
 * 非 darwin 下 registry 平台过滤让生效组合为空, 监听不命中, 无需再判平台。
 */
export function useRegionCaptureShortcut(
  addClipboardImage: (blob: Blob) => Promise<void>,
  options: { enabled?: boolean } = {},
): void {
  const addClipboardImageRef = useRef(addClipboardImage);
  addClipboardImageRef.current = addClipboardImage;

  useAppShortcut(
    'capture-region',
    () => {
      void (async () => {
        try {
          const result = await window.electronAPI.screenCapture.captureRegion();
          if (result.cancelled || !result.data) return;
          const blob = new Blob([result.data as BlobPart], { type: 'image/png' });
          await addClipboardImageRef.current(blob);
        } catch (err) {
          console.warn('[useRegionCaptureShortcut] region capture failed', err);
        }
      })();
      return true;
    },
    { enabled: options.enabled ?? true, stopImmediate: true },
  );
}
