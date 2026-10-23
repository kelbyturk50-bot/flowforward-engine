import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BookkeepingPrototype } from './agents';
import { presentBrand } from './brand';
import CtaPanel from './CtaPanel';
import { TEST_BRAND } from './fixture-brand';
import PrototypeLayout from './PrototypeLayout';

const DOLLAR_AMOUNT = /\$\s?\d/;

function textOutsideSampleValues(container) {
  const clone = container.cloneNode(true);
  for (const node of clone.querySelectorAll('.prototype-value')) node.remove();
  return clone.textContent;
}

describe('CtaPanel', () => {
  it('does not show service prices', () => {
    render(<CtaPanel />);
    const panel = screen.getByRole('complementary', { name: "How we'd make this real" });
    expect(panel).toHaveTextContent("How we'd make this real");
    expect(panel).toHaveTextContent('Connect your phone, calendar or books.');
    expect(panel).toHaveTextContent('We configure and test it with you.');
    expect(panel).toHaveTextContent('Go live, with hosting and maintenance.');
    expect(screen.getByRole('link', { name: 'Talk to Kelby' })).toHaveAttribute('href', '#talk-to-kelby');
    expect(panel.querySelector('p')).toBeNull();
    const text = panel.textContent;
    expect(text).not.toMatch(DOLLAR_AMOUNT);
    expect(text).not.toContain('MVP build');
    expect(text).not.toContain('Hosting $');
    expect(text).not.toContain('Consulting $');
  });

  it('keeps dollars off a prototype page except marked sample values', () => {
    const { container } = render(
      <PrototypeLayout brand={presentBrand(TEST_BRAND)}>
        <BookkeepingPrototype />
      </PrototypeLayout>,
    );
    const panel = container.querySelector('.prototype-cta');
    expect(panel).not.toBeNull();
    expect(panel.textContent).not.toMatch(DOLLAR_AMOUNT);
    expect(panel.textContent).not.toContain('MVP build');
    expect(textOutsideSampleValues(container)).not.toMatch(DOLLAR_AMOUNT);
    const samples = [...container.querySelectorAll('.prototype-value')].map((node) => node.textContent);
    expect(samples.some((text) => DOLLAR_AMOUNT.test(text))).toBe(true);
  });
});
