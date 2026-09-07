import { describe, expect, it } from 'vitest';

import {
  CHAT_BRIDGE_USER_AGENT,
  resolveConversationSessionHeaders,
  withChatBridgeUserAgent,
} from '../session-header.js';

describe('resolveConversationSessionHeaders (#4073)', () => {
  it('maps the Codex thread-id to x-opencode-session', () => {
    expect(resolveConversationSessionHeaders({ 'thread-id': 'thr_0190abc-1234' }))
      .toEqual({ 'x-opencode-session': 'thr_0190abc-1234' });
  });

  it('prefers an explicit inbound x-opencode-session over thread-id (case-insensitive, trimmed)', () => {
    expect(resolveConversationSessionHeaders({
      'X-OpenCode-Session': '  conv-explicit ',
      'Thread-Id': 'thr_ignored',
    })).toEqual({ 'x-opencode-session': 'conv-explicit' });
  });

  it('never derives a session from parent-thread, auth or other inbound headers', () => {
    expect(resolveConversationSessionHeaders({
      'x-codex-parent-thread-id': 'parent-1',
      authorization: 'Bearer secret',
      'chatgpt-account-id': 'acct',
      'x-client-request-id': 'req-per-request',
    })).toEqual({});
    expect(resolveConversationSessionHeaders(undefined)).toEqual({});
    expect(resolveConversationSessionHeaders({})).toEqual({});
  });

  it('rejects non-token session values instead of forwarding arbitrary strings', () => {
    expect(resolveConversationSessionHeaders({ 'thread-id': 'has space' })).toEqual({});
    expect(resolveConversationSessionHeaders({ 'thread-id': 'a\r\nx-injected: 1' })).toEqual({});
    expect(resolveConversationSessionHeaders({ 'thread-id': 'x'.repeat(129) })).toEqual({});
    expect(resolveConversationSessionHeaders({ 'thread-id': 'x'.repeat(128) }))
      .toEqual({ 'x-opencode-session': 'x'.repeat(128) });
  });
});

describe('withChatBridgeUserAgent', () => {
  it('adds the bridge User-Agent when the provider headers have none', () => {
    expect(withChatBridgeUserAgent({ authorization: 'Bearer k' }))
      .toEqual({ authorization: 'Bearer k', 'user-agent': CHAT_BRIDGE_USER_AGENT });
  });

  it('keeps an explicit provider User-Agent (any casing) untouched', () => {
    expect(withChatBridgeUserAgent({ 'User-Agent': 'my-ua/2' })).toEqual({ 'User-Agent': 'my-ua/2' });
  });
});
