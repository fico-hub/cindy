import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));

import { writeDocsOutput } from '../docsOutputWriter.js';

class FakeChild extends EventEmitter {
  readonly posted: unknown[] = [];
  killed = false;
  stderr = null;
  result: unknown = { ok: true };
  postMessage(message: unknown): void {
    this.posted.push(message);
    // Echo a success result the way the real one-shot writer does.
    queueMicrotask(() => this.emit('message', this.result));
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let root: string;
let child: FakeChild;

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-docs-writer-boundary-'));
  child = new FakeChild();
  forkMock.mockReset();
  forkMock.mockImplementation(() => {
    queueMicrotask(() => child.emit('message', { type: 'ready' }));
    return child;
  });
});

afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('writeDocsOutput beforeCommit boundary', () => {
  it('runs beforeCommit after readiness and before the bytes are posted to the writer', async () => {
    const order: string[] = [];
    const beforeCommit = vi.fn(async () => {
      order.push('beforeCommit');
      expect(child.posted).toHaveLength(0);
    });
    await writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false, beforeCommit });
    order.push('written');
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(order).toEqual(['beforeCommit', 'written']);
    expect(child.posted).toEqual([expect.objectContaining({ type: 'write' })]);
  });

  it('never hands the bytes to the writer when beforeCommit rejects', async () => {
    const beforeCommit = vi.fn(async () => {
      throw new Error('instance ended');
    });
    await expect(
      writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false, beforeCommit }),
    ).rejects.toThrow('instance ended');
    expect(child.posted).toEqual([]);
    expect(child.killed).toBe(true);
    await expect(fs.promises.access(path.join(root, 'out.txt'))).rejects.toThrow();
  });

  it('returns the published inode identity as decimal strings', async () => {
    child.result = { ok: true, identity: { dev: 16777234n, ino: 2n ** 60n + 1n } };
    const outcome = await writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false });
    expect(outcome).toEqual({ identity: { dev: '16777234', ino: (2n ** 60n + 1n).toString() } });
  });

  it('reports no identity when the writer did not attest one', async () => {
    child.result = { ok: true, identity: { dev: 1, ino: 2 } };
    const outcome = await writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false });
    expect(outcome).toEqual({});
  });

  it('keeps the plain path when no beforeCommit is supplied', async () => {
    await writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false });
    expect(child.posted).toEqual([expect.objectContaining({ type: 'write' })]);
  });
});
