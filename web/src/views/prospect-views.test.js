import { describe, expect, it } from 'vitest';
import { hasProspectViewFields, prospectViewCopy } from './prospect-views.js';

const LAST = '2026-11-14T21:14:00.000Z';
const SINCE = '2026-11-15T13:03:00.000Z';
const LAST_MT = 'last Nov 14, 2026, 2:14 PM MT';
const SINCE_MT = 'counting since Nov 15, 2026, 6:03 AM MT';

describe('prospect view copy', () => {
  it('treats a missing key as the flag-off shape', () => {
    const proposal = { views: 9, last_viewed_at: LAST };
    expect(hasProspectViewFields(proposal)).toBe(false);
    expect(prospectViewCopy(proposal)).toBeNull();
    expect(prospectViewCopy(null)).toBeNull();
  });

  it('says not tracked when all four fields are null', () => {
    const copy = prospectViewCopy({
      prospect_views: null,
      last_prospect_view_at: null,
      internal_views: null,
      counting_since: null,
      views: 9,
    });
    expect(copy).toEqual({
      tracked: false,
      main: 'Prospect views: not tracked',
      last: '',
      since: '',
      secondary: '',
    });
  });

  it('says not tracked and names counting since when the row predates counting', () => {
    const copy = prospectViewCopy({
      prospect_views: null,
      last_prospect_view_at: null,
      internal_views: null,
      counting_since: SINCE,
      views: 4,
    });
    expect(copy.tracked).toBe(false);
    expect(copy.main).toBe('Prospect views: not tracked');
    expect(copy.since).toBe(SINCE_MT);
    expect(copy.last).toBe('');
    expect(copy.secondary).toBe('');
  });

  it('counts integer zeros as tracked and omits a missing last view', () => {
    const copy = prospectViewCopy({
      prospect_views: 0,
      last_prospect_view_at: null,
      internal_views: 0,
      counting_since: SINCE,
      views: 9,
    });
    expect(copy).toEqual({
      tracked: true,
      main: 'Prospect views 0',
      last: '',
      since: '',
      secondary: 'Team/scanner views 0',
    });
  });

  it('shows a team-only window as prospect 0, not as untracked', () => {
    const copy = prospectViewCopy({
      prospect_views: 0,
      last_prospect_view_at: null,
      internal_views: 5,
      counting_since: SINCE,
      views: 3,
    });
    expect(copy.main).toBe('Prospect views 0');
    expect(copy.last).toBe('');
    expect(copy.secondary).toBe('Team/scanner views 5');
  });

  it('uses the prospect integer and a Denver last-view time', () => {
    const copy = prospectViewCopy({
      prospect_views: 2,
      last_prospect_view_at: LAST,
      internal_views: 3,
      counting_since: SINCE,
      views: 9,
      last_viewed_at: LAST,
    });
    expect(copy.main).toBe('Prospect views 2');
    expect(copy.last).toBe(LAST_MT);
    expect(copy.secondary).toBe('Team/scanner views 3');
    expect(copy.since).toBe('');
  });

  it('does not treat a null prospect count as tracked when the team count is an integer', () => {
    const copy = prospectViewCopy({
      prospect_views: null,
      internal_views: 3,
      counting_since: SINCE,
    });
    expect(copy.tracked).toBe(false);
    expect(copy.main).toBe('Prospect views: not tracked');
    expect(copy.secondary).toBe('');
  });
});
