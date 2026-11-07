import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VoiceCallPanel from './VoiceCallPanel.jsx';
import { proxyFetch, refusalText, startVoiceCall } from './voice-client.js';

const TOKEN = 'v'.repeat(43);
const AVAILABLE = { available: true, maxSeconds: 180, callsLeft: 2 };

function fakeCall() {
  return { end: vi.fn(async () => {}), mute: vi.fn(), unmute: vi.fn() };
}

describe('voice client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      call_id: 'call_1', access_token: 'tok', transport: 'gateway',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('routes only create-web-call to our session route and refuses anything else', async () => {
    const refused = vi.fn();
    const proxied = proxyFetch(TOKEN, refused);
    const other = await proxied('https://api.retellai.com/v2/stop-call/call_1', { method: 'POST' });
    expect(other.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const made = await proxied('https://api.retellai.com/v3/create-web-call', { method: 'POST', body: '{"agent_id":"x"}' });
    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ call_id: 'call_1', access_token: 'tok', transport: 'gateway' });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toMatch(new RegExp(`/api/public/prototypes/${TOKEN}/voice/session$`));
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe('{}');
    expect(init.headers.Authorization).toBeUndefined();
    expect(refused).not.toHaveBeenCalled();
  });

  it('reports a refusal and hands the SDK no Retell key', async () => {
    fetch.mockResolvedValueOnce(new Response('{"error":"voice_limit","reason":"link"}', { status: 429 }));
    const refused = vi.fn();
    let config;
    const createWebCall = vi.fn(() => fakeCall());
    const loadSdk = async () => ({
      RetellClient: class {
        constructor(c) { config = c; }
        createWebCall(o) { return createWebCall(o); }
      },
    });
    await startVoiceCall({ token: TOKEN, hooks: {}, onRefused: refused, loadSdk });
    expect(config.key).toBe('proxied');
    const res = await config.fetch('https://api.retellai.com/v3/create-web-call', {});
    expect(res.status).toBe(429);
    expect(refused).toHaveBeenCalledWith(429, { error: 'voice_limit', reason: 'link' });
    expect(refusalText(429, { error: 'voice_limit', reason: 'link' })).toMatch(/used its sample calls/);
    expect(refusalText(429, { error: 'voice_rate' })).toMatch(/Try again in an hour/);
    expect(refusalText(502, { error: 'voice_failed' })).toMatch(/didn't connect/);
  });
});

describe('VoiceCallPanel', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('renders nothing when voice is off for this link', async () => {
    const { container } = render(<VoiceCallPanel token={TOKEN} readStatus={async () => ({ available: false, reason: 'off' })} />);
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    const none = render(<VoiceCallPanel token={TOKEN} readStatus={async () => null} />);
    await act(async () => {});
    expect(none.container).toBeEmptyDOMElement();
  });

  it('calls, shows the countdown and controls, and ends the call', async () => {
    let hooks;
    const call = fakeCall();
    const startCall = vi.fn(async (opts) => { hooks = opts.hooks; return call; });
    render(<VoiceCallPanel token={TOKEN} businessName="Sample Ridge Heating" readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    const button = await screen.findByRole('button', { name: 'Call the receptionist' });
    expect(screen.getByText(/Sample Ridge Heating's AI receptionist/)).toBeInTheDocument();
    expect(screen.getByText(/No phone number is dialed and nothing is booked/)).toBeInTheDocument();
    await userEvent.click(button);
    expect(startCall).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN }));
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    act(() => hooks.onStatus('live'));
    expect(screen.getByText('Live · 3:00 left')).toBeInTheDocument();
    expect(screen.getByText('Try saying')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(call.mute).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'End call' }));
    expect(call.end).toHaveBeenCalled();
    act(() => hooks.onEnd({}));
    expect(screen.getByText(/On a live line, the owner gets a text/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call again' })).toBeEnabled();
  });

  it('shows the API refusal in plain words', async () => {
    const startCall = vi.fn(async (opts) => {
      opts.onRefused(429, { error: 'voice_limit', reason: 'link' });
      throw new Error('refused');
    });
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has used its sample calls.');
    expect(screen.getByRole('button', { name: 'Call the receptionist' })).toBeDisabled();
  });

  it('asks for the microphone when the browser blocks it', async () => {
    let hooks;
    const startCall = vi.fn(async (opts) => { hooks = opts.hooks; return fakeCall(); });
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    act(() => hooks.onError(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })));
    expect(screen.getByRole('alert')).toHaveTextContent('Allow the microphone');
  });

  it('ends a call that finishes starting after the panel is gone', async () => {
    const call = fakeCall();
    let resolve;
    const startCall = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { unmount } = render(<VoiceCallPanel token={TOKEN} readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    unmount();
    await act(async () => { resolve(call); });
    expect(call.end).toHaveBeenCalled();
  });

  it('Cancel while connecting ends the call once it exists', async () => {
    const call = fakeCall();
    let resolve;
    const startCall = vi.fn(() => new Promise((r) => { resolve = r; }));
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolve(call); });
    expect(call.end).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Call again' })).toBeEnabled();
  });

  it('keeps End and Mute when a non-fatal error arrives during a live call', async () => {
    let hooks;
    const call = { ...fakeCall(), status: 'live' };
    const startCall = vi.fn(async (opts) => { hooks = opts.hooks; return call; });
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => AVAILABLE} startCall={startCall} preload={async () => ({})} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    act(() => hooks.onStatus('live'));
    act(() => hooks.onError(new Error('transient')));
    expect(screen.getByRole('button', { name: 'End call' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('connection hiccuped');
  });

  it('a refused call does not use up one of the link\'s calls', async () => {
    let hooks;
    const startCall = vi.fn(async (opts) => {
      hooks = opts.hooks;
      opts.onRefused(429, { error: 'voice_limit', reason: 'busy' });
      return fakeCall();
    });
    const preload = vi.fn(async () => ({}));
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => ({ ...AVAILABLE, callsLeft: 1 })} startCall={startCall} preload={preload} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Call the receptionist' }));
    expect(preload).toHaveBeenCalled();
    act(() => hooks.onEnd({}));
    expect(screen.getByRole('alert')).toHaveTextContent('The demo line is busy');
    expect(screen.getByRole('button', { name: 'Call again' })).toBeEnabled();
  });

  it('says when a link has used its calls', async () => {
    render(<VoiceCallPanel token={TOKEN} readStatus={async () => ({ available: false, reason: 'limit' })} />);
    expect(await screen.findByText(/This link has used its sample calls/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call the receptionist' })).toBeDisabled();
  });
});
