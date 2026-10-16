import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
const mobileAt = css.indexOf('/* ── Mobile');
const desktop = css.slice(0, mobileAt);
const phone = css.slice(css.lastIndexOf('@media (max-width: 860px)'));

describe('phone tap targets', () => {
  it('grows the short controls to 44px inside the phone query', () => {
    const rules = [
      '.mini-select { min-height: 44px;',
      '.chip { min-height: 44px; display: inline-flex; align-items: center;',
      '.drawer-close { width: 44px; height: 44px;',
      '.head-chips .linklike { display: inline-flex; align-items: center; min-height: 44px;',
      '.input { min-height: 44px;',
      '.task-body { min-height: 44px;',
      '.task input[type="checkbox"], .check input[type="checkbox"] { width: 44px; height: 44px;',
      '.tally a { display: inline-flex; align-items: center; min-height: 44px;',
      'input[type="range"] { min-height: 44px;',
      '.skip { min-height: 44px;',
      '.preview summary, .raw summary { display: flex; align-items: center; min-height: 44px;',
    ];
    for (const rule of rules) {
      expect(phone).toContain(rule);
      expect(desktop).not.toContain(rule);
    }
  });

  it('keeps the desktop control sizes in the base stylesheet', () => {
    expect(desktop).toContain('min-height: 40px; padding: 0 1rem;');
    expect(desktop).toContain('.btn-sm { min-height: 32px;');
    expect(desktop).toContain('.input {\n  min-height: 40px;');
    expect(desktop).toContain('.linklike { border: 0; background: none; padding: 0;');
    expect(desktop).toContain('.mini-select { border: 1px solid var(--line); background: var(--surface); border-radius: 4px; font-size: .8rem; padding: .1rem .2rem;');
    expect(desktop).toContain('.drawer-close { position: absolute; top: .8rem; right: .8rem; width: 36px; height: 36px;');
    expect(desktop).toContain('.task input[type="checkbox"] { width: 20px; height: 20px;');
    expect(desktop).toContain('.raw summary, .preview summary { cursor: pointer; color: var(--juniper); font-weight: 500; }');
    expect(desktop).not.toMatch(/summary \{[^}]*min-height/);
    expect(desktop).not.toMatch(/\.mini-select \{[^}]*min-height/);
    expect(desktop).not.toMatch(/\.task-body \{[^}]*min-height/);
  });
});
