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
  parseFlagUpdate,
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
    expect(apiSrc).toMatch(/flags:\s+\(\)\s+=>\s+request\('GET', FEATURE_FLAGS_API\.list\)\.then\(parseFlagsPayload\)/);
    expect(apiSrc).toMatch(/setFlag:.*\.then\(parseFlagUpdate\),/);
    expect(FEATURE_FLAGS_API.list).toBe('/api/flags');
    expect(FEATURE_FLAGS_API.update('FF_CAMPAIGNS')).toBe('/api/flags/FF_CAMPAIGNS');
    expect(FEATURE_FLAGS_API.update('A B')).toBe('/api/flags/A%20B');
    expect(FEATURE_FLAGS_API.body(true)).toEqual({ enabled: true });
    expect(FEATURE_FLAGS_API.body(1)).toEqual({ enabled: false });
    expect(FEATURE_FLAGS_API.body('true')).toEqual({ enabled: false });
  });

  it('lists the campaign flags and leaves live sending and the watermark out', () => {
    expect(FEATURE_FLAG_NAMES).toContain('FF_CAMPAIGNS');
    expect(FEATURE_FLAG_NAMES).toContain('FF_LIVE_CHAT_DEMO');
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
        writable: false,
        source: 'db',
      },
      {
        name: 'FF_CAMPAIGN_OPEN_PIXEL',
        enabled: false,
        updated_at: null,
        updated_by: 'env',
        env_forced_off: true,
        writable: false,
        source: 'db',
      },
    ]);
  });

  it('parses the #70 server Flag: effective wins, env force wins, writable must be true', () => {
    const server = (extra) => ({
      name: 'FF_CAMPAIGNS',
      enabled: false,
      effective: false,
      env_forced_off: false,
      updated_at: null,
      updated_by: null,
      writable: true,
      source: 'db',
      ...extra,
    });
    expect(parseFlagRecord(server({ enabled: true, effective: true }))).toMatchObject({ enabled: true, writable: true, source: 'db' });
    expect(parseFlagRecord(server({ enabled: true, effective: false, env_forced_off: true }))).toMatchObject({ enabled: false, env_forced_off: true });
    expect(parseFlagRecord(server({ enabled: true, effective: true, env_forced_off: true })).enabled).toBe(false);
    expect(parseFlagRecord(server({ enabled: true, effective: 'true' })).enabled).toBe(true);
    expect(parseFlagRecord(server({ enabled: 'true', effective: 'true' })).enabled).toBe(false);
    expect(parseFlagRecord(server({ writable: 'true' })).writable).toBe(false);
    expect(parseFlagRecord(server({ name: 'FF_PILOT_ESTIMATE_SMS', writable: false, source: 'env', enabled: true, effective: true })))
      .toMatchObject({ enabled: true, writable: false, source: 'env' });
  });

  it('reads PUT { flag } and fails closed on anything else', () => {
    const flag = {
      name: 'FF_CAMPAIGNS',
      enabled: true,
      effective: true,
      env_forced_off: false,
      updated_at: '2026-10-20T18:00:00.000Z',
      updated_by: 'crm',
      writable: true,
      source: 'db',
    };
    expect(parseFlagUpdate({ flag })).toEqual({
      name: 'FF_CAMPAIGNS',
      enabled: true,
      updated_at: '2026-10-20T18:00:00.000Z',
      updated_by: 'crm',
      env_forced_off: false,
      writable: true,
      source: 'db',
    });
    for (const payload of [flag, null, undefined, {}, { flag: null }, { flag: 'FF_CAMPAIGNS' }, []]) {
      expect(() => parseFlagUpdate(payload)).toThrow(/missing the flag/);
    }
  });

  it('shows every catalog flag as off when the server omits it', () => {
    const rows = panelFlagsFromRecords([
      { name: 'FF_PROTOTYPE_GALLERY', enabled: true, writable: true },
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
    const locked = Object.fromEntries(rows.map((flag) => [flag.name, flag.writable]));
    expect(locked.FF_PROTOTYPE_GALLERY).toBe(true);
    expect(locked.FF_CAMPAIGNS).toBe(false);
    expect(FEATURE_FLAG_NAMES).toContain('FF_PROTOTYPE_ON_DRAFT');
  });
});
