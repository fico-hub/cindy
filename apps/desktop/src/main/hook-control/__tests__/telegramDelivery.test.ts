import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTelegramDeliveryBridge, selectTelegramDeliveryTarget, type TelegramDeliveryInput } from '../telegramDelivery';

const binding = { bindingId: 'bound', principalId: 'owner', principalName: 'Owner', scopeId: 'bot', scopeName: 'test_bot' };
const target = selectTelegramDeliveryTarget(binding, ['telegram:dm:bot:owner:g1'])!;
const input: TelegramDeliveryInput = {
  idempotencyKey: 'sample:part:1', target, text: '<b>新版日报测试 📮</b>', tier: 'html',
  sourceSha256: 'a'.repeat(64), presentationSha256: 'b'.repeat(64),
};
const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-telegram-delivery-'));
  directories.push(directory);
  const status = vi.fn(() => ({ connected: true, supported: true, target }));
  const send = vi.fn(async (payload: { opId: string }) => ({ opId: payload.opId, ok: true, messageId: '123' }));
  return { directory, status, send, bridge: createTelegramDeliveryBridge({ directory, status, send }) };
}
describe('official Telegram delivery', () => {
  it('selects only an existing DM for the live principal and bot, using latest generation', () => {
    expect(selectTelegramDeliveryTarget(binding, [
      'telegram:dm:bot:other:g90', 'telegram:group:bot:-10:owner:g9',
      'telegram:dm:bot:owner:g2', 'telegram:dm:bot:owner:g10', 'telegram:dm:other:owner:g99',
    ])?.externalKey).toBe('telegram:dm:bot:owner:g10');
    expect(selectTelegramDeliveryTarget(binding, ['telegram:dm:bot:other:g1'])).toBeNull();
    expect(selectTelegramDeliveryTarget(binding, ['telegram:dm:owner:g1'])).toBeNull();
  });
  it('persists started before sending and preserves real receipt across restarts', async () => {
    const h = harness();
    h.send.mockImplementation(async payload => {
      expect(h.bridge.receipt(input.idempotencyKey)?.state).toBe('started');
      return { opId: payload.opId, ok: true, messageId: '123' };
    });
    const receipt = await h.bridge.send(input);
    expect(receipt).toMatchObject({ state: 'sent', target, formatVerified: false, result: { messageId: '123' } });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      scope: { externalKey: target.externalKey }, action: { kind: 'send', text: input.text, tier: 'html' },
    }));
    const restarted = createTelegramDeliveryBridge(h);
    expect(await restarted.send(input)).toEqual(receipt);
    expect(h.send).toHaveBeenCalledTimes(1);
    await expect(restarted.send({ ...input, text: 'changed' })).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it.each(['timeout', 'negative', 'missing-id', 'wrong-op'])('never resends %s outcomes', async kind => {
    const h = harness();
    const send = vi.fn(async (payload: { opId: string }) => {
      if (kind === 'timeout') throw new Error('secret transport detail');
      if (kind === 'negative') return { opId: payload.opId, ok: false, error: 'upstream unavailable' };
      if (kind === 'wrong-op') return { opId: 'another-operation', ok: true, messageId: '123' };
      return { opId: payload.opId, ok: true };
    });
    const bridge = createTelegramDeliveryBridge({ ...h, send });
    expect((await bridge.send(input)).state).toBe('unknown');
    expect((await bridge.send(input)).state).toBe('unknown');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('excludes a concurrent process while the first send is still in flight', async () => {
    const h = harness();
    let finish!: (v: { opId: string; ok: boolean; messageId: string }) => void;
    let opId = '';
    const send = vi.fn((p: { opId: string }) => { opId = p.opId; return new Promise<{ opId: string; ok: boolean; messageId: string }>(r => { finish = r; }); });
    const a = createTelegramDeliveryBridge({ ...h, send });
    const b = createTelegramDeliveryBridge({ ...h, send });
    const pending = a.send(input);
    expect((await b.send(input)).state).toBe('started');
    finish({ opId, ok: true, messageId: '7' });
    expect((await pending).state).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not create claims for old servers, disconnected accounts or changed targets', async () => {
    const h = harness();
    h.status.mockReturnValue({ connected: true, supported: false, target });
    await expect(h.bridge.send(input)).rejects.toThrow();
    h.status.mockReturnValue({ connected: false, supported: true, target });
    await expect(h.bridge.send(input)).rejects.toThrow();
    h.status.mockReturnValue({ connected: true, supported: true, target: { ...target, principalId: 'new-owner' } });
    await expect(h.bridge.send(input)).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.directory)).toEqual([]);
  });
  it('accepts a matching late receipt after timeout without sending again', async () => {
    const h = harness();
    const send = vi.fn(async () => null);
    const bridge = createTelegramDeliveryBridge({ ...h, send });
    const unknown = await bridge.send(input);
    expect(unknown.state).toBe('unknown');
    bridge.onResult({ opId: unknown.opId, ok: true, messageId: 'late-42' });
    expect(bridge.receipt(input.idempotencyKey)).toMatchObject({ state: 'sent', result: { messageId: 'late-42' } });
    expect((await bridge.send(input)).state).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not send after a torn journal write' , async () => {
    const h = harness();
    fs.writeFileSync(path.join(h.directory, createHash('sha256').update(input.idempotencyKey).digest('hex') + '.json'), '{');
    await expect(h.bridge.send(input)).rejects.toThrow('DELIVERY_JOURNAL_UNREADABLE');
    expect(h.send).not.toHaveBeenCalled();
  });
});

