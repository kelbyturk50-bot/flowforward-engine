import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAG_NAMES,
  FEATURE_FLAGS_API,
  closedPanelFlags,
  panelFlagsFromRecords,
  parseFlagRecord,
  parseFlagsPayload,
} from './flags-contract.js';

const root = path.dirname(fileURLToPath(import.meta.url));

describe('feature flags contract', () => {
  it('keeps the endpoint shape in one module', () => {
    const apiSrc = readFileSync(path.join(root, 'api.js'), 'utf8');
    expect(apiSrc).toContain('FEATURE_FLAGS_API.list');
    expect(apiSrc).toContain('FEATURE_FLAGS_API.update');
    expect(apiSrc).toContain('FEATURE_FLAGS_API.body');
    expect(apiSrc).not.toMatch(/['"`]\/api\/flags/);
    expect(FEATURE_FLAGS_API.list).toBe('/api/flags');
    expect(FEATURE_FLAGS_API.update('FF_CAMPAIGNS')).toBe('/api/flags/FF_CAMPAIGNS');
    expect(FEATURE_FLAGS_API.update('A B')).toBe('/api/flags/A%20B');
    expect(FEATURE_FLAGS_API.body(true)).toEqual({ enabled: true });
    expect(FEATURE_FLAGS_API.body(1)).toEqual({ enabled: false });
    expect(FEATURE_FLAGS_API.body('true')).toEqual({ enabled: false });
  });

  it('lists the campaign flags and leaves live sending and the watermark out', () => {
    expect(FEATURE_FLAG_NAMES).toContain('FF_CAMPAIGNS');
    expect(FEATURE_FLAG_NAMES).toContain('FF_CAMPAIGN_OPEN_PIXEL');
    expect(FEATURE_FLAG_NAMES).not.toContain('FF_PILOT_ESTIMATE_LIVE_SEND');
    expect(FEATURE_FLAG_NAMES).not.toContain('FF_HIDE_WATERMARK');
    const closed = closedPanelFlags();
    expect(closed.every((flag) => flag.enabled === false)).toBe(true);
    expect(closed.map((flag) => flag.name)).toEqual([...FEATURE_FLAG_NAMES]);
  });

  it('rejects a payload that is not { flags: [] }', () => {
    for (const payload of [null, undefined, {}, { flags: null }, { flags: {} }, [], 'FF_CAMPAIGNS']) {
      expect(() => parseFlagsPayload(payload)).toThrow(/not a list/);
    }
    expect(() => parseFlagRecord(null)).toThrow(/missing a name/);
    expect(() => parseFlagRecord({})).toThrow(/missing a name/);
  });

  it('fails closed on loose values and drops flags the panel must not toggle', () => {
    const rows = parseFlagsPayload({
      flags: [
        { name: 'FF_CAMPAIGNS', enabled: 'true', updated_by: '  Kelby  ', updated_at: '2026-10-16T18:00:00.000Z' },
        { name: 'FF_CAMPAIGN_OPEN_PIXEL', enabled: true, env_forced_off: true, updated_by: 'env' },
        { name: 'FF_PILOT_ESTIMATE_LIVE_SEND', enabled: true },
        { name: 'FF_HIDE_WATERMARK', enabled: true },
        { name: '', enabled: true },
        null,
      ],
    });
    expect(rows).toEqual([
      {
        name: 'FF_CAMPAIGNS',
        enabled: false,
        updated_at: '2026-10-16T18:00:00.000Z',
        updated_by: 'Kelby',
        env_forced_off: false,
      },
      {
        name: 'FF_CAMPAIGN_OPEN_PIXEL',
        enabled: false,
        updated_at: null,
        updated_by: 'env',
        env_forced_off: true,
      },
    ]);
  });

  it('shows every catalog flag as off when the server omits it', () => {
    const rows = panelFlagsFromRecords([
      { name: 'FF_PROTOTYPE_GALLERY', enabled: true },
      { name: 'FF_PILOT_ESTIMATE_LIVE_SEND', enabled: true },
      { name: 'FF_EXTRA', enabled: true },
    ]);
    const byName = Object.fromEntries(rows.map((flag) => [flag.name, flag.enabled]));
    expect(byName.FF_PROTOTYPE_GALLERY).toBe(true);
    expect(byName.FF_CAMPAIGNS).toBe(false);
    expect(byName.FF_CAMPAIGN_OPEN_PIXEL).toBe(false);
    expect(byName.FF_EXTRA).toBe(true);
    expect(rows.some((flag) => flag.name === 'FF_PILOT_ESTIMATE_LIVE_SEND')).toBe(false);
    expect(panelFlagsFromRecords(null).every((flag) => flag.enabled === false)).toBe(true);
  });
});
