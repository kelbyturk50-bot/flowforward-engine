import { describe, expect, it } from 'vitest';
import { PRODUCTION_HOSTS } from './api-base.js';
import {
  FF_PILOT_ESTIMATE_RECOVERY,
  FF_PILOT_ESTIMATE_SMS,
  FF_PILOT_LINK_ON_ONEPAGER,
  FF_PROTOTYPE_GALLERY,
  FF_LIVE_CHAT_DEMO,
  FF_CAMPAIGNS,
  FLAG_STORAGE_KEY,
  PREVIEW_HOST_PATTERN,
  _setFeatureFlagsForTests,
  beginFlagLoad,
  failFlagLoad,
  flagEnabled,
  flagOverrideAllowed,
  readCompanyOverride,
  readPilotFlags,
  resetRemoteFlags,
} from './flags.js';

const ALL_OFF = {
  [FF_PILOT_ESTIMATE_RECOVERY]: false,
  [FF_PILOT_LINK_ON_ONEPAGER]: false,
  [FF_PILOT_ESTIMATE_SMS]: false,
  [FF_PROTOTYPE_GALLERY]: false,
  [FF_LIVE_CHAT_DEMO]: false,
  [FF_CAMPAIGNS]: false,
};

const PREVIEW = 'flowforward-engine-x-turk11.vercel.app';
const DEPLOY = 'flowforward-engine-abc123-turk11.vercel.app';
const PREVIEW_ENV = { DEV: false, VERCEL_ENV: 'preview' };
const PROD_BUILD = { DEV: false, VERCEL_ENV: 'production' };
const ALL_FLAGS = `${FF_PILOT_ESTIMATE_RECOVERY},${FF_PILOT_LINK_ON_ONEPAGER},${FF_PILOT_ESTIMATE_SMS},${FF_PROTOTYPE_GALLERY}`;

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

function flagsAt(href, { env = { DEV: false, VERCEL_ENV: '' }, storage = mem() } = {}) {
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
      expect(flagOverrideAllowed(loc(href), { DEV: false, VERCEL_ENV: 'preview' })).toBe(false);
      expect(flagOverrideAllowed(loc(href), { DEV: true, VERCEL_ENV: 'production' })).toBe(false);
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
      expect(flagsAt(href, { env: PREVIEW_ENV })).toEqual(ALL_OFF);
      expect(flagOverrideAllowed(loc(href), PREVIEW_ENV)).toBe(false);
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
      { storage, env: PREVIEW_ENV },
    );
    expect(on).toEqual({
      [FF_PILOT_ESTIMATE_RECOVERY]: true,
      [FF_PILOT_LINK_ON_ONEPAGER]: true,
      [FF_PILOT_ESTIMATE_SMS]: false,
      [FF_PROTOTYPE_GALLERY]: false,
      [FF_LIVE_CHAT_DEMO]: false,
      [FF_CAMPAIGNS]: false,
    });
    expect(storage.getItem(FLAG_STORAGE_KEY)).toBe(`${FF_PILOT_ESTIMATE_RECOVERY},${FF_PILOT_LINK_ON_ONEPAGER}`);
    expect(flagsAt(`https://${PREVIEW}/demo/estimate-recovery/demo-example-heating-air`, { storage, env: PREVIEW_ENV })).toEqual(on);
  });

  it('treats an explicit :443 as the default https port', () => {
    const page = new URL(`https://${PREVIEW}:443/?flags=${FF_PILOT_ESTIMATE_RECOVERY}`);
    expect(page.port).toBe('');
    expect(flagsAt(page.href, { env: PREVIEW_ENV })[FF_PILOT_ESTIMATE_RECOVERY]).toBe(true);
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
    const named = flagsAt(`https://${PREVIEW}/?flags=${FF_PILOT_ESTIMATE_RECOVERY},FF_NOT_A_FLAG`, { env: PREVIEW_ENV });
    expect(named[FF_PILOT_ESTIMATE_RECOVERY]).toBe(true);
    expect(named.FF_PILOT_ESTIMATE_SMS).toBe(false);
    expect(named.FF_NOT_A_FLAG).toBeUndefined();
    expect(flagsAt(`https://${PRODUCTION_HOSTS[0]}/?flags=${ALL_FLAGS}`, { storage })).toEqual(ALL_OFF);
    expect(storage.getItem(FLAG_STORAGE_KEY)).toBe(ALL_FLAGS);
  });

  it('honors ?company= only where the flag override is honored', () => {
    const preview = `https://${PREVIEW}/?company=Sample%20Heating%20Co`;
    expect(readCompanyOverride({ location: loc(preview), env: PREVIEW_ENV })).toBe('Sample Heating Co');
    expect(readCompanyOverride({
      location: loc(`https://${PRODUCTION_HOSTS[0]}/?company=Sample%20Heating%20Co`),
      env: { DEV: true },
    })).toBe('');
    expect(readCompanyOverride({
      location: loc(`http://${PREVIEW}/?company=Sample%20Heating%20Co`),
      env: PREVIEW_ENV,
    })).toBe('');
    expect(readCompanyOverride({
      location: loc(`http://localhost:5173/?company=%20Sample%20Heating%20Co%20`),
      env: { DEV: true },
    })).toBe('Sample Heating Co');
    expect(readCompanyOverride({
      location: loc(`https://${PREVIEW}/?company=${'A'.repeat(120)}`),
      env: PREVIEW_ENV,
    })).toHaveLength(80);
  });

  it('keeps FF_PROTOTYPE_GALLERY off on production hosts even with ?flags= set', () => {
    for (const hostname of PRODUCTION_HOSTS) {
      const href = `https://${hostname}/demo/gallery/demo-test-wasatch-heating?flags=${FF_PROTOTYPE_GALLERY}`;
      expect(flagsAt(href, { env: { DEV: true } })[FF_PROTOTYPE_GALLERY]).toBe(false);
      expect(flagsAt(href, { env: { DEV: false } })).toEqual(ALL_OFF);
      expect(flagOverrideAllowed(loc(href), { DEV: true })).toBe(false);
      expect(flagOverrideAllowed(loc(href), { DEV: false })).toBe(false);
    }
    const gitMain = 'flowforward-engine-git-main-turk11.vercel.app';
    expect(PREVIEW_HOST_PATTERN.test(gitMain)).toBe(true);
    expect(flagsAt(`https://${gitMain}/?flags=${FF_PROTOTYPE_GALLERY}`, { env: { DEV: true } })[FF_PROTOTYPE_GALLERY]).toBe(false);
  });

  it('keeps FF_CAMPAIGNS off unless a preview host or dev localhost names it', () => {
    expect(flagsAt(`https://${PREVIEW}/`)[FF_CAMPAIGNS]).toBe(false);
    expect(flagsAt(`https://${PREVIEW}/?flags=${FF_CAMPAIGNS}`, { env: PREVIEW_ENV })[FF_CAMPAIGNS]).toBe(true);
    expect(flagsAt(`http://${PREVIEW}/?flags=${FF_CAMPAIGNS}`, { env: PREVIEW_ENV })[FF_CAMPAIGNS]).toBe(false);
    expect(flagsAt(`https://${PREVIEW}:444/?flags=${FF_CAMPAIGNS}`, { env: PREVIEW_ENV })[FF_CAMPAIGNS]).toBe(false);
    const dev = 'http://localhost:5173/?flags=FF_CAMPAIGNS';
    expect(flagsAt(dev, { env: { DEV: true } })[FF_CAMPAIGNS]).toBe(true);
    expect(flagsAt(dev, { env: { DEV: false } })[FF_CAMPAIGNS]).toBe(false);
    expect(flagsAt('http://127.0.0.1:5173/?flags=FF_CAMPAIGNS', { env: { DEV: true } })[FF_CAMPAIGNS]).toBe(false);
    for (const hostname of PRODUCTION_HOSTS) {
      expect(flagsAt(`https://${hostname}/?flags=${FF_CAMPAIGNS}`, { env: { DEV: true } })[FF_CAMPAIGNS]).toBe(false);
    }
  });

  it('turns FF_PROTOTYPE_GALLERY on only for a preview host or dev localhost', () => {
    expect(flagsAt(`https://${PREVIEW}/?flags=${FF_PROTOTYPE_GALLERY}`, { env: PREVIEW_ENV })[FF_PROTOTYPE_GALLERY]).toBe(true);
    expect(flagsAt(`http://${PREVIEW}/?flags=${FF_PROTOTYPE_GALLERY}`, { env: PREVIEW_ENV })[FF_PROTOTYPE_GALLERY]).toBe(false);
    expect(flagsAt(`https://${PREVIEW}:444/?flags=${FF_PROTOTYPE_GALLERY}`, { env: PREVIEW_ENV })[FF_PROTOTYPE_GALLERY]).toBe(false);
    const dev = 'http://localhost:5173/?flags=FF_PROTOTYPE_GALLERY';
    expect(flagsAt(dev, { env: { DEV: true } })[FF_PROTOTYPE_GALLERY]).toBe(true);
    expect(flagsAt(dev, { env: { DEV: false } })[FF_PROTOTYPE_GALLERY]).toBe(false);
    expect(flagsAt('http://127.0.0.1:5173/?flags=FF_PROTOTYPE_GALLERY', { env: { DEV: true } })[FF_PROTOTYPE_GALLERY]).toBe(false);
  });
});

describe('feature flag source', () => {
  const host = PRODUCTION_HOSTS[0];

  function at(href, env = { DEV: false, VERCEL_ENV: '' }, storage = mem()) {
    return { location: loc(href), storage, env };
  }

  it('keeps ?flags= preview-only for campaign flags', () => {
    resetRemoteFlags();
    const storage = mem();
    const preview = at(`https://${PREVIEW}/?flags=FF_CAMPAIGNS,FF_CAMPAIGN_OPEN_PIXEL`, PREVIEW_ENV, storage);
    expect(flagEnabled('FF_CAMPAIGNS', preview)).toBe(true);
    expect(flagEnabled('FF_CAMPAIGN_OPEN_PIXEL', preview)).toBe(true);
    expect(flagEnabled('FF_PILOT_ESTIMATE_RECOVERY', preview)).toBe(false);
    expect(storage.getItem(FLAG_STORAGE_KEY)).toBe('FF_CAMPAIGNS,FF_CAMPAIGN_OPEN_PIXEL');

    for (const hostname of PRODUCTION_HOSTS) {
      const stored = mem({ [FLAG_STORAGE_KEY]: 'FF_CAMPAIGNS,FF_CAMPAIGN_OPEN_PIXEL' });
      const prod = at(`https://${hostname}/?flags=FF_CAMPAIGNS,FF_CAMPAIGN_OPEN_PIXEL`, { DEV: true }, stored);
      expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(false);
      expect(flagEnabled('FF_CAMPAIGN_OPEN_PIXEL', prod)).toBe(false);
      expect(stored.getItem(FLAG_STORAGE_KEY)).toBe('FF_CAMPAIGNS,FF_CAMPAIGN_OPEN_PIXEL');
    }
    expect(flagEnabled('FF_CAMPAIGNS', at(`http://${PREVIEW}/?flags=FF_CAMPAIGNS`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_CAMPAIGNS', at(`https://${PREVIEW}:444/?flags=FF_CAMPAIGNS`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_CAMPAIGNS', at('http://127.0.0.1:5173/?flags=FF_CAMPAIGNS', { DEV: true }))).toBe(false);
    expect(flagEnabled('FF_CAMPAIGNS', at('http://localhost:5173/?flags=FF_CAMPAIGNS', { DEV: true }))).toBe(true);
    expect(flagEnabled('FF_CAMPAIGNS', at('http://localhost:5173/?flags=FF_CAMPAIGNS', { DEV: false }))).toBe(false);
  });

  it('uses the API value when no preview override is active', () => {
    _setFeatureFlagsForTests([
      { name: 'FF_CAMPAIGNS', enabled: true, env_forced_off: false },
      { name: 'FF_CAMPAIGN_OPEN_PIXEL', enabled: false },
    ]);
    const prod = at(`https://${host}/?flags=FF_CAMPAIGN_OPEN_PIXEL`, { DEV: true });
    expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(true);
    expect(flagEnabled('FF_CAMPAIGN_OPEN_PIXEL', prod)).toBe(false);
    expect(flagEnabled('FF_PROTOTYPE_GALLERY', prod)).toBe(false);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', prod)).toBe(false);
  });

  it('keeps FF_LIVE_CHAT_DEMO off unless a preview host or dev localhost names it', () => {
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(`https://${PREVIEW}/`))).toBe(false);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(`https://${PREVIEW}/?flags=FF_LIVE_CHAT_DEMO`, PREVIEW_ENV))).toBe(true);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(`http://${PREVIEW}/?flags=FF_LIVE_CHAT_DEMO`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(`https://${PREVIEW}:444/?flags=FF_LIVE_CHAT_DEMO`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at('http://localhost:5173/?flags=FF_LIVE_CHAT_DEMO', { DEV: true }))).toBe(true);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at('http://localhost:5173/?flags=FF_LIVE_CHAT_DEMO', { DEV: false }))).toBe(false);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at('http://127.0.0.1:5173/?flags=FF_LIVE_CHAT_DEMO', { DEV: true }))).toBe(false);
    for (const hostname of PRODUCTION_HOSTS) {
      expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(`https://${hostname}/?flags=FF_LIVE_CHAT_DEMO`, { DEV: true }))).toBe(false);
    }
  });

  it('lets a preview override replace API values', () => {
    _setFeatureFlagsForTests([
      { name: 'FF_CAMPAIGNS', enabled: true },
      { name: 'FF_PILOT_ESTIMATE_RECOVERY', enabled: true },
    ]);
    const preview = at(`https://${PREVIEW}/?flags=FF_PROTOTYPE_GALLERY`, PREVIEW_ENV);
    expect(flagEnabled('FF_PROTOTYPE_GALLERY', preview)).toBe(true);
    expect(flagEnabled('FF_CAMPAIGNS', preview)).toBe(false);
    expect(flagEnabled('FF_PILOT_ESTIMATE_RECOVERY', preview)).toBe(false);
  });

  it('fails closed when the load errors, and ignores hidden flags', () => {
    _setFeatureFlagsForTests([
      { name: 'FF_CAMPAIGNS', enabled: true },
      { name: 'FF_HIDE_WATERMARK', enabled: true },
      { name: 'FF_PILOT_ESTIMATE_LIVE_SEND', enabled: true },
    ]);
    const prod = at(`https://${host}/`, { DEV: true });
    expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(true);
    expect(flagEnabled('FF_HIDE_WATERMARK', at(`https://${PREVIEW}/?flags=FF_HIDE_WATERMARK`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_PILOT_ESTIMATE_LIVE_SEND', at(`https://${PREVIEW}/?flags=FF_PILOT_ESTIMATE_LIVE_SEND`, PREVIEW_ENV))).toBe(false);
    expect(flagEnabled('FF_HIDE_WATERMARK', prod)).toBe(false);
    expect(flagEnabled('FF_PILOT_ESTIMATE_LIVE_SEND', prod)).toBe(false);

    const ticket = beginFlagLoad();
    expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(false);
    failFlagLoad(ticket, new Error('Database unavailable'));
    expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(false);
    expect(flagEnabled('FF_CAMPAIGN_OPEN_PIXEL', prod)).toBe(false);

    _setFeatureFlagsForTests([{ name: 'FF_CAMPAIGNS', enabled: true, env_forced_off: true }]);
    expect(flagEnabled('FF_CAMPAIGNS', prod)).toBe(false);
  });

  it('ignores ?flags= on a production build even when the host matches the preview regex', () => {
    expect(PREVIEW_HOST_PATTERN.test(DEPLOY)).toBe(true);
    expect(PRODUCTION_HOSTS).not.toContain(DEPLOY);
    const href = `https://${DEPLOY}/demo/live-chat?flags=${FF_PROTOTYPE_GALLERY},${FF_LIVE_CHAT_DEMO}`;
    for (const env of [PROD_BUILD, { DEV: false, VERCEL_ENV: '' }, { DEV: false }]) {
      expect(flagOverrideAllowed(loc(href), env)).toBe(false);
      expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(href, env))).toBe(false);
      expect(flagEnabled('FF_PROTOTYPE_GALLERY', at(href, env))).toBe(false);
    }
  });

  it('honors ?flags= on a preview build when the host matches, and on dev localhost', () => {
    const href = `https://${DEPLOY}/?flags=${FF_PROTOTYPE_GALLERY},${FF_LIVE_CHAT_DEMO}`;
    expect(flagOverrideAllowed(loc(href), PREVIEW_ENV)).toBe(true);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(href, PREVIEW_ENV))).toBe(true);
    expect(flagEnabled('FF_PROTOTYPE_GALLERY', at(href, PREVIEW_ENV))).toBe(true);
    expect(flagOverrideAllowed(loc(href), PROD_BUILD)).toBe(false);

    const dev = 'http://localhost:5173/?flags=FF_LIVE_CHAT_DEMO';
    expect(flagOverrideAllowed(loc(dev), { DEV: true, VERCEL_ENV: '' })).toBe(true);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at(dev, { DEV: true, VERCEL_ENV: '' }))).toBe(true);
    expect(flagOverrideAllowed(loc(dev), { DEV: true, VERCEL_ENV: 'production' })).toBe(true);
    expect(flagEnabled('FF_LIVE_CHAT_DEMO', at('http://127.0.0.1:5173/?flags=FF_LIVE_CHAT_DEMO', { DEV: true, VERCEL_ENV: 'preview' }))).toBe(false);
  });
});
