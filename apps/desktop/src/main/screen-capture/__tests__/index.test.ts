import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenCaptureRegionResult } from '../../../shared/screenCapture.js';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  execFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(async () => undefined),
  assertTrusted: vi.fn(),
  clipboardWriteImage: vi.fn(),
  createFromBuffer: vi.fn((buffer: Buffer) => ({ buffer })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  clipboard: { writeImage: mocks.clipboardWriteImage },
  nativeImage: { createFromBuffer: mocks.createFromBuffer },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, rm: mocks.rm }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrusted,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerScreenCaptureIpc } from '../index.js';

type Handler = (event: unknown) => Promise<ScreenCaptureRegionResult>;

function registerAndGetHandler(platform: string): Handler {
  registerScreenCaptureIpc(platform);
  const call = mocks.handle.mock.calls.at(-1);
  expect(call?.[0]).toBe('screen-capture:region');
  return call?.[1] as Handler;
}

/** execFile 的 callback 形态实现(promisify 走 (file, args, opts, cb))。 */
function execFileResolving(run: () => Error | null) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
      cb(run(), { stdout: '', stderr: '' });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerScreenCaptureIpc', () => {
  it('rejects on non-darwin platforms', async () => {
    const handler = registerAndGetHandler('win32');
    await expect(handler({})).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('returns PNG bytes on successful capture and cleans up the temp file', async () => {
    execFileResolving(() => null);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mocks.readFile.mockResolvedValue(bytes);
    const handler = registerAndGetHandler('darwin');

    const result = await handler({});
    expect(result).toEqual({ ok: true, cancelled: false, data: bytes });
    const [bin, args] = mocks.execFile.mock.calls[0];
    expect(bin).toBe('/usr/sbin/screencapture');
    expect(args).toContain('-i');
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    // 成功路径同步写系统剪贴板(其它 composer 直接 ⌘V)。
    expect(mocks.createFromBuffer).toHaveBeenCalledWith(bytes);
    expect(mocks.clipboardWriteImage).toHaveBeenCalledTimes(1);
  });

  it('treats non-zero screencapture exit as user cancel', async () => {
    execFileResolving(() => new Error('exit 1'));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: true });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.clipboardWriteImage).not.toHaveBeenCalled();
  });

  it('treats a missing output file as cancel', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: true });
  });

  it('reports an empty output file as INTERNAL', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockResolvedValue(Buffer.alloc(0));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('dedupes concurrent captures: second call resolves cancelled without spawning', async () => {
    let release!: () => void;
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
        release = () => cb(null, { stdout: '', stderr: '' });
      },
    );
    mocks.readFile.mockResolvedValue(Buffer.from([1]));
    const handler = registerAndGetHandler('darwin');

    const first = handler({});
    const second = await handler({});
    expect(second).toEqual({ ok: true, cancelled: true });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ ok: true, cancelled: false });
  });

  it('gates every call on the trusted-renderer check', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockResolvedValue(Buffer.from([1]));
    mocks.assertTrusted.mockImplementation(() => {
      throw Object.assign(new Error('untrusted'), { code: 'PERMISSION_DENIED' });
    });
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
