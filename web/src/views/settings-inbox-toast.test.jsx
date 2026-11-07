import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Settings from './Settings';
import { Toaster } from '../ui';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';

const shared = { version: 0, onSaved: () => {} };

function renderSettings() {
  return render(
    <>
      <Settings {...shared} />
      <Toaster />
    </>
  );
}

beforeEach(() => {
  installApiDefaults();
});

describe('Check inbox toast', () => {
  it('says 0 new messages, 1 new message, and 2 new messages', async () => {
    const user = userEvent.setup();
    const cases = [
      { checked: 0, sent: 0, text: 'Read 0 new messages, 0 matched. 0 follow-ups sent.' },
      { checked: 1, sent: 1, text: 'Read 1 new message, 1 matched. 1 follow-up sent.' },
      { checked: 2, sent: 2, text: 'Read 2 new messages, 0 matched. 2 follow-ups sent.' },
    ];
    for (const item of cases) {
      api.checkInbox.mockResolvedValueOnce({
        inbox: { checked: item.checked, matched: item.checked === 1 ? 1 : 0, caught_up: true },
        followups: { held: false, sent: item.sent },
      });
    }
    renderSettings();
    const button = await screen.findByRole('button', { name: 'Check inbox for replies now' });
    for (const item of cases) {
      await user.click(button);
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(item.text));
    }
  });

  it('disables Check inbox while a check is running and says nothing was sent when held', async () => {
    const user = userEvent.setup();
    let resolveCheck;
    api.checkInbox.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve; }));
    renderSettings();
    const button = await screen.findByRole('button', { name: 'Check inbox for replies now' });
    const pending = user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    resolveCheck({
      inbox: { checked: 1, matched: 1, caught_up: false, backlog: 3 },
      followups: { held: true, sent: 0 },
    });
    await pending;
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Read 1 new message, 1 matched. Follow-ups wait until the inbox is caught up (3 still to read). Nothing was sent.'));
    const status = screen.getByRole('status');
    expect(status.textContent).not.toMatch(/follow-ups sent/);
    await waitFor(() => expect(button).toBeEnabled());
  });
});
