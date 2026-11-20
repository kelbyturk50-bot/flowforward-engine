import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_LIST_KIND_FIELD, CALL_LIST_SET_AT_FIELD, CALL_OUTCOMES, ApiError, api } from './src/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status, body) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('call list client', () => {
  it('keeps the outcome strings and the marker field in one place', () => {
    expect(CALL_OUTCOMES).toEqual([
      'no_answer',
      'voicemail',
      'talked',
      'audit_booked',
      'not_interested',
      'do_not_contact',
    ]);
    expect(CALL_LIST_KIND_FIELD).toBe('call_list_kind');
    expect(CALL_LIST_SET_AT_FIELD).toBe('call_list_set_at');
  });

  it('calls the proposed routes and dispatches 401 the way the rest of the API does', async () => {
    const fetchMock = stubFetch(200, { enabled: false, items: [] });
    await api.todayCallList();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/today/call-list', expect.objectContaining({ method: 'GET' }));
    fetchMock.mockClear();
    await api.todayCallList({ all: true });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/today/call-list?all=1', expect.objectContaining({ method: 'GET' }));

    fetchMock.mockClear();
    stubFetch(200, { activity_id: 1, removed: true, back_on: null });
    const again = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ activity_id: 1, removed: true, back_on: null }) }));
    vi.stubGlobal('fetch', again);
    await api.recordCallOutcome(41, { outcome: 'no_answer', kind: 'call', extra: 'nope' });
    expect(again).toHaveBeenCalledWith(
      'http://localhost:3000/api/prospects/41/call-outcome',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ outcome: 'no_answer', kind: 'call' }),
      }),
    );

    const put = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', put);
    await api.saveCallListKind('11', 'walk_in');
    expect(put).toHaveBeenCalledWith(
      'http://localhost:3000/api/prospects/11/call-list',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ kind: 'walk_in' }) }),
    );

    const del = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', del);
    await api.removeCallList(11);
    expect(del).toHaveBeenCalledWith(
      'http://localhost:3000/api/prospects/11/call-list',
      expect.objectContaining({ method: 'DELETE' }),
    );

    const denied = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Missing or invalid API key' }) }));
    vi.stubGlobal('fetch', denied);
    const heard = [];
    window.addEventListener('ff:unauthorized', () => heard.push('401'), { once: true });
    await expect(api.todayCallList()).rejects.toMatchObject({ status: 401 });
    expect(heard).toEqual(['401']);

    expect(() => api.recordCallOutcome('nope', { outcome: 'talked', kind: 'call' })).toThrow(ApiError);
  });
});
