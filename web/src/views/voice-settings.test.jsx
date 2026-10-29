import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import VoiceSettings from './VoiceSettings';

beforeEach(() => { installApiDefaults(); });

describe('VoiceSettings', () => {
  it('says calls are off until the Railway values are set, and shows setup', async () => {
    render(<VoiceSettings version={0} />);
    expect(await screen.findByText(/Off\. Calls turn on when RETELL_API_KEY, RETELL_AGENT_ID and VOICE_DEMO_DAILY_MINUTES/)).toBeInTheDocument();
    expect(screen.getByText('http://127.0.0.1:3000/api/public/voice/retell-webhook')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Set up in Retell'));
    expect(screen.getByText(/You are the AI receptionist for \{\{business_name\}\}/)).toBeInTheDocument();
  });

  it('shows the daily budget and today\'s minutes when on', async () => {
    api.voiceStatus.mockResolvedValue({
      configured: true, daily_minutes: 30, max_call_seconds: 180, calls_per_link: 3, seconds_per_link: 360,
      today: { day: '2026-10-29', calls: 2, used_seconds: 95, held_seconds: 180 },
      webhook_url: 'https://api.example/api/public/voice/retell-webhook', prompt: 'p',
    });
    render(<VoiceSettings version={0} />);
    expect(await screen.findByText(/On\. Up to 30 minutes a day across all links\. Each prototype link gets up to 3 calls and 6 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/2 calls · 1.6 min used · 3 min held/)).toBeInTheDocument();
  });
});
