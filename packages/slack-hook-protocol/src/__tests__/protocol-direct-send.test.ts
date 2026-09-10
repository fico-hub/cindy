import { describe, expect, it } from 'vitest';
import { makeMessageOp, makeMessageOpResult, parseHookMessage, serializeHookMessage } from '../index';

describe('owner DM send wire compatibility', () => {
  it('preserves the binding, epoch and deadline without changing legacy sends or reactions', () => {
    for (const action of [
      { kind: 'send' as const, text: '<b>📮</b>', tier: 'html' as const, delivery: { bindingId: 'binding', epoch: 'epoch', expiresAt: 60000 } },
      { kind: 'react' as const, targetMessageId: '1', emoji: '👀' },
      { kind: 'send' as const, text: 'legacy' },
    ]) {
      const frame = makeMessageOp({ opId: 'op', scope: { externalKey: 'telegram:dm:1:2:g1' }, action });
      const parsed = parseHookMessage(serializeHookMessage(frame));
      expect(parsed).toMatchObject({ ok: true, message: { payload: frame.payload } });
    }
  });
  it('keeps actual text and UTF-16 entities in a direct send receipt', () => {
    const frame = makeMessageOpResult({ opId: 'op', ok: true, messageId: '1', deliveryState: 'sent',
      sentMessage: { chatId: '2', text: '📮 hi', tier: 'html', entities: [{ type: 'bold', offset: 3, length: 2 }] } });
    expect(parseHookMessage(serializeHookMessage(frame))).toMatchObject({ ok: true, message: { payload: frame.payload } });
    for (const bad of [{ offset: -1 }, { length: 0 }, { length: 99 }, { offset: 0.5 }, { url: 5 }]) {
      const raw = JSON.parse(serializeHookMessage(frame));
      Object.assign(raw.payload.sentMessage.entities[0], bad);
      expect(parseHookMessage(JSON.stringify(raw)).ok).toBe(false);
    }
  });
  it('accepts missing new fields from old servers without inventing delivery guarantees', () => {
    expect(parseHookMessage(serializeHookMessage(makeMessageOpResult({ opId: 'op', ok: true, messageId: '1' })))).toMatchObject({ ok: true });
  });
});
