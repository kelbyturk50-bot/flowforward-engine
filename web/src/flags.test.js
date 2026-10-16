import { describe, expect, it } from 'vitest';
import { PRODUCTION_HOSTS } from './api-base.js';
import {
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_ESTIMATE_SMS,
  FF_PILOT_LINK_ON_ONEPAGER,
  FLAG_STORAGE_KEY,
  PREVIEW_HOST_PATTERN,
  flagOverrideAllowed,
  readCompanyOverride,
  readPilotFlags,
} from './flags.js';

const ALL_OFF = {
  [FF_PILOT_ESTIMATE_RECOVERY]: false,
  [FF_PILOT_LINK_ON_ONEPAGER]: false,
  [FF_PILOT_ESTIMATE_SMS]: false,
};

const PREVIEW = 'flowforward-engine-x-turk11.vercel.app';
const ALL_FLAGS = `${FF_PILOT_ESTIMATE_RECOVERY},${FF_PILOT_LINK_ON_ONEPAGER},${FF_PILOT_ESTIMATE_SMS}`;

function mem(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

function loc(href) {
  const url = new URL(href);
  return { protocol: url.protocol, port: url.port, hostname: url.hostname, search: url.search };
}

function flagsAt(href, { env = { DEV: false }, storage = mem() } = {}) {
  return readPilotFlags({ location: loc(href), storage, env });
}

describe('pilot flags', () => {
  it('defaults every flag to off', () => {
    expect(flagsAt(`https://${PREVIEW}/`)).toEqual(ALL_OFF);
    expect(flagsAt('http://localhost:5173/', { env: { DEV: true } })).toEqual(ALL_OFF);
    expect(readPilotFlags({
      location: window.location,
      storage: mem(),
      env: import.meta.env,
    })).toEqual(ALL_OFF);
  });

  it('stays off on each production host even with ?flags= set', () => {
    for (const hostname of PRODUCTION_HOSTS) {
      const href = `https://${hostname}/?flags=${ALL_FLAGS}`;
      expect(flagsAt(href, { env: { DEV: true } })).toEqual(ALL_OFF);
      expect(flagOverrideAllowed(loc(href), { DEV: false })).toBe(false);
      expect(flagOverrideAllowed(loc(href), { DEV: true })).toBe(false);
    }
  });

  it('rejects the git-main production host before the preview regex', () => {
    const gitMain = 'flowforward-engine-git-main-turk11.vercel.app';
    expect(PRODUCTION_HOSTS).toContain(gitMain);
    expect(PREVIEW_HOST_PATTERN.test(gitMain)).toBe(true);
    expect(flagsAt(`https://${gitMain}/demo/estimate-recovery/demo-example-heating-air?flags=${ALL_FLAGS}`)).toEqual(ALL_OFF);
  });

  it('stays off on lookalike hosts, http, and port 444', () => {
    const lookalikes = [
      'https://a.flowforward-engine-x-turk11.vercel.app/?flags=' + ALL_FLAGS,
      'https://flowforward-engine-x-turk11.vercel.app.evil.com/?flags=' + ALL_FLAGS,
      'https://xflowforward-engine-x-turk11.vercel.app/?flags=' + ALL_FLAGS,
      `http://${PREVIEW}/?flags=${ALL_FLAGS}`,
      `https://${PREVIEW}:444/?flags=${ALL_FLAGS}`,
    ];
    for (const href of lookalikes) {
      const page = new URL(href);
      expect(flagsAt(href)).toEqual(ALL_OFF);
      expect(flagOverrideAllowed(loc(href), { DEV: false })).toBe(false);
      if (page.hostname !== PREVIEW) expect(PREVIEW_HOST_PATTERN.test(page.hostname)).toBe(false);
    }
    const port = new URL(`https://${PREVIEW}:444/`);
    expect(port.port).toBe('444');
    expect(port.protocol).toBe('https:');
    const insecure = new URL(`http://${PREVIEW}/`);
    expect(insecure.protocol).toBe('http:');
    expect(insecure.port).toBe('');
  });

  it('turns on only the named flags on a preview host', () => {
    expect(PRODUCTION_HOSTS).not.toContain(PREVIEW);
    expect(PREVIEW_HOST_PATTERN.test(PREVIEW)).toBe(true);
    const storage = mem();
    const on = flagsAt(
      `https://${PREVIEW}/?flags=${FF_PILOT_ESTIMATE_RECOVERY},${FF_PILOT_LINK_ON_ONEPAGER}`,
      { storage },
    );
    expect(on).toEqual({
      [FF_PILOT_ESTIMATE_RECOVERY]: true,
      [FF_PILOT_LINK_ON_ONEPAGER]: true,
      [FF_PILOT_ESTIMATE_SMS]: false,
    });
    expect(storage.getItem(FLAG_STORAGE_KEY)).toBe(`${FF_PILOT_ESTIMATE_RECOVERY},${FF_PILOT_LINK_ON_ONEPAGER}`);
    expect(flagsAt(`https://${PREVIEW}/demo/estimate-recovery/demo-example-heating-air`, { storage })).toEqual(on);
  });

  it('treats an explicit :443 as the default https port', () => {
    const page = new URL(`https://${PREVIEW}:443/?flags=${FF_PILOT_ESTIMATE_RECOVERY}`);
    expect(page.port).toBe('');
    expect(flagsAt(page.href)[FF_PILOT_ESTIMATE_RECOVERY]).toBe(true);
  });

  it('allows the query on localhost only while DEV is on', () => {
    const href = `http://localhost:5173/?flags=${FF_PILOT_ESTIMATE_RECOVERY}`;
    expect(flagOverrideAllowed(loc(href), { DEV: true })).toBe(true);
    expect(flagsAt(href, { env: { DEV: true } })[FF_PILOT_ESTIMATE_RECOVERY]).toBe(true);
    expect(flagsAt(href, { env: { DEV: false } })).toEqual(ALL_OFF);
    expect(flagsAt(`http://127.0.0.1:5173/?flags=${ALL_FLAGS}`, { env: { DEV: true } })).toEqual(ALL_OFF);
  });

  it('ignores unknown names and does not read stored flags on a closed host', () => {
    const storage = mem({ [FLAG_STORAGE_KEY]: ALL_FLAGS });
    expect(flagsAt(`https://${PREVIEW}/?flags=${FF_PILOT_ESTIMATE_RECOVERY},FF_NOT_A_FLAG`).FF_PILOT_ESTIMATE_SMS).toBe(false);
    expect(flagsAt(`https://${PRODUCTION_HOSTS[0]}/?flags=${ALL_FLAGS}`, { storage })).toEqual(ALL_OFF);
    expect(storage.getItem(FLAG_STORAGE_KEY)).toBe(ALL_FLAGS);
  });

  it('honors ?company= only where the flag override is honored', () => {
    const preview = `https://${PREVIEW}/?company=Sample%20Heating%20Co`;
    expect(readCompanyOverride({ location: loc(preview), env: { DEV: false } })).toBe('Sample Heating Co');
    expect(readCompanyOverride({
      location: loc(`https://${PRODUCTION_HOSTS[0]}/?company=Sample%20Heating%20Co`),
      env: { DEV: true },
    })).toBe('');
    expect(readCompanyOverride({
      location: loc(`http://${PREVIEW}/?company=Sample%20Heating%20Co`),
      env: { DEV: false },
    })).toBe('');
    expect(readCompanyOverride({
      location: loc(`http://localhost:5173/?company=%20Sample%20Heating%20Co%20`),
      env: { DEV: true },
    })).toBe('Sample Heating Co');
    expect(readCompanyOverride({
      location: loc(`https://${PREVIEW}/?company=${'A'.repeat(120)}`),
      env: { DEV: false },
    })).toHaveLength(80);
  });
});
