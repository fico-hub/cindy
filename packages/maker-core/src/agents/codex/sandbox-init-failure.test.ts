import { describe, expect, it } from 'vitest';

import {
  CODEX_SANDBOX_INIT_FAILURE_NOTE,
  annotateSandboxInitFailure,
  isBwrapSandboxInitFailureOutput,
} from './sandbox-init-failure.js';

describe('isBwrapSandboxInitFailureOutput (#3793)', () => {
  it('locks the reported RTM_NEWADDR init-failure shape', () => {
    expect(isBwrapSandboxInitFailureOutput(
      'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
    )).toBe(true);
  });

  it('accepts multi-line pure bwrap diagnostics', () => {
    expect(isBwrapSandboxInitFailureOutput([
      'bwrap: setting up uid map: Permission denied',
      '',
      'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted',
    ].join('\n'))).toBe(true);
  });

  it('rejects output once any command line appears (command actually ran)', () => {
    expect(isBwrapSandboxInitFailureOutput(
      'bwrap: some warning\nls: cannot access /x: No such file or directory\n',
    )).toBe(false);
    expect(isBwrapSandboxInitFailureOutput(
      'total 0\ndrwxr-xr-x 2 u u 40 .\n',
    )).toBe(false);
  });

  it('rejects empty and null output', () => {
    expect(isBwrapSandboxInitFailureOutput('')).toBe(false);
    expect(isBwrapSandboxInitFailureOutput('\n \n')).toBe(false);
    expect(isBwrapSandboxInitFailureOutput(null)).toBe(false);
    expect(isBwrapSandboxInitFailureOutput(undefined)).toBe(false);
  });
});

describe('annotateSandboxInitFailure', () => {
  it('appends the host note for a failed init-failure item', () => {
    const out = annotateSandboxInitFailure(
      'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
      true,
    );
    expect(out).toContain('Failed RTM_NEWADDR');
    expect(out).toContain(CODEX_SANDBOX_INIT_FAILURE_NOTE);
  });

  it('leaves ordinary command failures untouched', () => {
    const text = 'tsc: error TS2322: type mismatch\n';
    expect(annotateSandboxInitFailure(text, true)).toBe(text);
  });

  it('never annotates successful items even with bwrap-looking output', () => {
    const text = 'bwrap: some diagnostic\n';
    expect(annotateSandboxInitFailure(text, false)).toBe(text);
  });
});
