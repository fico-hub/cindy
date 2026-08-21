import { describe, expect, it } from 'vitest';

import { normalizeSelectionRect } from '../regionCaptureSelection';

describe('normalizeSelectionRect', () => {
  const bounds = { width: 1920, height: 1080 };

  it('normalizes a forward drag', () => {
    expect(normalizeSelectionRect({ x: 10, y: 20 }, { x: 110, y: 220 }, bounds)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it('normalizes a backward drag (any direction yields positive size)', () => {
    expect(normalizeSelectionRect({ x: 110, y: 220 }, { x: 10, y: 20 }, bounds)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 200,
    });
  });

  it('clamps to overlay bounds when the drag leaves the window', () => {
    expect(normalizeSelectionRect({ x: 1900, y: 1070 }, { x: 2500, y: 1500 }, bounds)).toEqual({
      x: 1900,
      y: 1070,
      width: 20,
      height: 10,
    });
    expect(normalizeSelectionRect({ x: -50, y: -50 }, { x: 30, y: 40 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 30,
      height: 40,
    });
  });

  it('a click without movement yields a zero-size rect (treated as cancel by main)', () => {
    expect(normalizeSelectionRect({ x: 5, y: 5 }, { x: 5, y: 5 }, bounds)).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});
