import { describe, expect, it } from 'vitest';
import { badgeCount, compactMoney } from './format.js';

describe('badgeCount', () => {
  it('hides zero and caps at 9+', () => {
    expect(badgeCount(0)).toBeNull();
    expect(badgeCount(null)).toBeNull();
    expect(badgeCount(-3)).toBeNull();
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(9)).toBe('9');
    expect(badgeCount(10)).toBe('9+');
    expect(badgeCount(14)).toBe('9+');
  });
});

describe('compactMoney', () => {
  it('abbreviates revenue the way a phone card does', () => {
    expect(compactMoney(1_200_000)).toBe('$1.2M');
    expect(compactMoney(2_100_000)).toBe('$2.1M');
    expect(compactMoney(1_000_000)).toBe('$1M');
    expect(compactMoney(850_000)).toBe('$850K');
    expect(compactMoney(12_500)).toBe('$12.5K');
    expect(compactMoney(8_000)).toBe('$8K');
    expect(compactMoney(4_500)).toBe('$4.5K');
    expect(compactMoney(450)).toBe('$450');
    expect(compactMoney(0)).toBe('$0');
    expect(compactMoney(null)).toBe('—');
    expect(compactMoney('')).toBe('—');
  });
});
