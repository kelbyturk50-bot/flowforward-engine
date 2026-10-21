import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { installApiDefaults } from '../test/defaults.js';
import PrototypeCard from './PrototypeCard';

const live = {
  id: 4, url: 'http://127.0.0.1:3000/demo/prototype/' + 'a'.repeat(43), agent_type: 'estimate_followup',
  colors: { primary: '#2f6b57', secondary: '#1e2a2f' },
  issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 13 * 864e5).toISOString(),
  expired: false, link_problem: null,
};

beforeEach(() => { installApiDefaults(); });

describe('PrototypeCard', () => {
  it('makes a prototype for a lead that has none', async () => {
    api.createPrototype.mockResolvedValue({ prototype: live });
    render(<PrototypeCard prospectId={12} prototype={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Make a prototype' }));
    expect(api.createPrototype).toHaveBeenCalledWith(12);
    expect(await screen.findByRole('link', { name: 'Open prototype' })).toHaveAttribute('href', live.url);
  });

  it('saves hand-entered colors and changes the featured agent', async () => {
    api.updatePrototype.mockResolvedValue({ prototype: { ...live, colors: { primary: '#c8102e', secondary: '#1e2a2f' } } });
    render(<PrototypeCard prospectId={12} prototype={live} />);
    expect(screen.queryByRole('button', { name: 'Save colors' })).toBeNull();
    const hex = screen.getByLabelText('Main color hex');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#c8102e');
    await userEvent.click(screen.getByRole('button', { name: 'Save colors' }));
    expect(api.updatePrototype).toHaveBeenCalledWith(4, { colors: { primary: '#c8102e', secondary: '#1e2a2f' } });
    await userEvent.selectOptions(screen.getByLabelText('Lead with'), 'scheduling');
    expect(api.updatePrototype).toHaveBeenCalledWith(4, { agent_type: 'scheduling' });
  });

  it('turns a link off only after a confirm, and shows expired links as expired', async () => {
    api.revokePrototype.mockResolvedValue({ id: 4 });
    const { unmount } = render(<PrototypeCard prospectId={12} prototype={live} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off link' }));
    expect(api.revokePrototype).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(api.revokePrototype).toHaveBeenCalledWith(4);
    expect(await screen.findByRole('button', { name: 'Make a prototype' })).toBeInTheDocument();
    unmount();
    render(<PrototypeCard prospectId={12} prototype={{ ...live, expired: true }} />);
    expect(screen.getByText(/Expired/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open prototype' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeInTheDocument();
  });
});
