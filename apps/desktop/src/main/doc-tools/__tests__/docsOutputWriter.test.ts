import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));

import { DOCS_OUTPUT_WRITER_ABORT_GRACE, DOCS_OUTPUT_WRITER_TIMEOUT, writeDocsOutput } from '../docsOutputWriter.js';

class FakeChild extends EventEmitter {
  readonly posted: unknown[] = [];
  killed = false;
  stderr = null;
  result: unknown = { ok: true };
  postMessage(message: unknown): void {
    this.posted.push(message);
    // Echo a success result the way the real one-shot writer does (null = never answers).
    if (this.result !== null) queueMicrotask(() => this.emit('message', this.result));
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let root: string;
let child: FakeChild;

beforeEach(async () => {
  DOCS_OUTPUT_WRITER_ABORT_GRACE.ms = 20;
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

  // Codex P1 (round 16): a killed writer cannot run its fail-closed path; the parent
  // reclaims the announced inode (staging + target names) before surfacing the timeout.
  it('reclaims the staged inode when the writer times out after announcing it', async () => {
    DOCS_OUTPUT_WRITER_TIMEOUT.ms = 30;
    try {
      const staging = path.join(root, '.cindy-docs-staging-u-out.txt');
      const target = path.join(root, 'out.txt');
      await fs.promises.writeFile(staging, 'private bytes', { mode: 0o600 });
      await fs.promises.link(staging, target);
      const st = await fs.promises.lstat(staging, { bigint: true });
      child.result = null; // never answers
      child.postMessage = function (this: FakeChild, message: unknown) {
        this.posted.push(message);
        queueMicrotask(() => this.emit('message', { type: 'staged', identity: { dev: st.dev, ino: st.ino }, stagingName: '.cindy-docs-staging-u-out.txt' }));
      };
      const settled = writeDocsOutput({ root, path: target, data: new Uint8Array([1]), overwrite: false }).then(() => 'resolved', (e: Error) => e.message);
      expect(await settled).toBe('文档落盘隔离进程超时');
      expect(child.killed).toBe(true);
      await expect(fs.promises.access(staging)).rejects.toThrow();
      await expect(fs.promises.access(target)).rejects.toThrow();
    } finally {
      DOCS_OUTPUT_WRITER_TIMEOUT.ms = 60_000;
    }
  });

  // Codex P1 (round 18): on watchdog timeout the parent first asks the child to clean up
  // through its cwd-bound capabilities (which survive a directory move-out); the parent's
  // path-based reclaim is only the fallback for a silent child.
  it('lets the child clean up on timeout and skips path reclaim when it confirms', async () => {
    DOCS_OUTPUT_WRITER_TIMEOUT.ms = 30;
    DOCS_OUTPUT_WRITER_ABORT_GRACE.ms = 500;
    try {
      const staging = path.join(root, '.cindy-docs-staging-u-out.txt');
      const target = path.join(root, 'out.txt');
      await fs.promises.writeFile(staging, 'child will handle these', { mode: 0o600 });
      await fs.promises.link(staging, target);
      const st = await fs.promises.lstat(staging, { bigint: true });
      child.result = null;
      const seen: string[] = [];
      child.postMessage = function (this: FakeChild, message: unknown) {
        const type = (message as { type?: string }).type ?? '';
        seen.push(type);
        if (type === 'write') queueMicrotask(() => this.emit('message', { type: 'staged', identity: { dev: st.dev, ino: st.ino }, stagingName: '.cindy-docs-staging-u-out.txt' }));
        if (type === 'abort') queueMicrotask(() => this.emit('message', { type: 'aborted', cleaned: true }));
      };
      const outcome = await writeDocsOutput({ root, path: target, data: new Uint8Array([1]), overwrite: false }).then(() => 'resolved', (e: Error) => e.message);
      expect(outcome).toBe('文档落盘隔离进程超时');
      expect(seen).toEqual(['write', 'abort']);
      expect(child.killed).toBe(true);
      // The child said it cleaned up; the parent must not touch the names by path.
      expect(await fs.promises.readFile(target, 'utf8')).toBe('child will handle these');
    } finally {
      DOCS_OUTPUT_WRITER_TIMEOUT.ms = 60_000;
    }
  });

  // Codex P1 (round 17b): a crash / external kill after the staged notice must reclaim the
  // inode exactly like the watchdog does, not just reject.
  it.each(['exit', 'error'])('reclaims the staged inode when the writer terminates abnormally (%s)', async (kind) => {
    const staging = path.join(root, '.cindy-docs-staging-u-out.txt');
    const target = path.join(root, 'out.txt');
    await fs.promises.writeFile(staging, 'private bytes', { mode: 0o600 });
    await fs.promises.link(staging, target);
    const st = await fs.promises.lstat(staging, { bigint: true });
    child.result = null;
    child.postMessage = function (this: FakeChild, message: unknown) {
      this.posted.push(message);
      queueMicrotask(() => {
        this.emit('message', { type: 'staged', identity: { dev: st.dev, ino: st.ino }, stagingName: '.cindy-docs-staging-u-out.txt' });
        queueMicrotask(() => (kind === 'exit' ? this.emit('exit', 137) : this.emit('error', new Error('spawn lost'))));
      });
    };
    const outcome = await writeDocsOutput({ root, path: target, data: new Uint8Array([1]), overwrite: false }).then(() => 'resolved', (e: Error) => e.message);
    expect(outcome).toMatch(kind === 'exit' ? /异常退出\(137\)/ : /spawn lost/);
    await expect(fs.promises.access(staging)).rejects.toThrow();
    await expect(fs.promises.access(target)).rejects.toThrow();
  });

  // Codex P1 (round 17): for overwrite the announced inode becomes the user's replaced file
  // once renamed; timeout reclamation may only touch the staging name.
  it('never reclaims the target name of an overwrite request on timeout', async () => {
    DOCS_OUTPUT_WRITER_TIMEOUT.ms = 30;
    try {
      const target = path.join(root, 'out.txt');
      await fs.promises.writeFile(target, 'replacement already renamed into place');
      const st = await fs.promises.lstat(target, { bigint: true });
      child.result = null;
      child.postMessage = function (this: FakeChild, message: unknown) {
        this.posted.push(message);
        queueMicrotask(() => this.emit('message', { type: 'staged', identity: { dev: st.dev, ino: st.ino }, stagingName: '.cindy-docs-staging-u-out.txt' }));
      };
      const pending = writeDocsOutput({ root, path: target, data: new Uint8Array([1]), overwrite: true }).catch((e: Error) => e.message);
      expect(await pending).toBe('文档落盘隔离进程超时');
      expect(await fs.promises.readFile(target, 'utf8')).toBe('replacement already renamed into place');
    } finally {
      DOCS_OUTPUT_WRITER_TIMEOUT.ms = 60_000;
    }
  });

  it('leaves unrelated files alone on timeout when the announced inode does not match', async () => {
    DOCS_OUTPUT_WRITER_TIMEOUT.ms = 30;
    try {
      const target = path.join(root, 'out.txt');
      await fs.promises.writeFile(target, 'someone else');
      child.result = null;
      child.postMessage = function (this: FakeChild, message: unknown) {
        this.posted.push(message);
        queueMicrotask(() => this.emit('message', { type: 'staged', identity: { dev: 1n, ino: 2n }, stagingName: '.cindy-docs-staging-u-out.txt' }));
      };
      const pending = writeDocsOutput({ root, path: target, data: new Uint8Array([1]), overwrite: false }).catch((e: Error) => e.message);
      expect(await pending).toBe('文档落盘隔离进程超时');
      expect(await fs.promises.readFile(target, 'utf8')).toBe('someone else');
    } finally {
      DOCS_OUTPUT_WRITER_TIMEOUT.ms = 60_000;
    }
  });

  it('keeps the plain path when no beforeCommit is supplied', async () => {
    await writeDocsOutput({ root, path: path.join(root, 'out.txt'), data: new Uint8Array([1]), overwrite: false });
    expect(child.posted).toEqual([expect.objectContaining({ type: 'write' })]);
  });
});
