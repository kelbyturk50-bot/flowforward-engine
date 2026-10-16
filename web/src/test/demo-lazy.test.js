import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('demo code split', () => {
  it('loads the fixture and the demo view with dynamic import', () => {
    const main = readFileSync(path.join(webRoot, 'src/main.jsx'), 'utf8');
    const gate = readFileSync(path.join(webRoot, 'src/demo/DemoGate.jsx'), 'utf8');
    const view = readFileSync(path.join(webRoot, 'src/demo/EstimateRecovery.jsx'), 'utf8');
    const adapter = readFileSync(path.join(webRoot, 'src/demo/getDemo.js'), 'utf8');
    const flags = readFileSync(path.join(webRoot, 'src/flags.js'), 'utf8');

    expect(main).not.toMatch(/fixture/);
    expect(main).not.toMatch(/EstimateRecovery/);
    expect(gate).toMatch(/import\(\s*['"]\.\/EstimateRecovery['"]\s*\)/);
    expect(gate).not.toMatch(/from ['"]\.\/fixture/);
    expect(view).not.toMatch(/from ['"]\.\/fixture/);
    expect(adapter).toMatch(/import\(\s*['"]\.\/fixture\.js['"]\s*\)/);
    expect(view).toMatch(/import\(\s*['"]\.\/fixture\.js['"]\s*\)/);
    const galleryGate = readFileSync(path.join(webRoot, 'src/prototypes/GalleryGate.jsx'), 'utf8');
    expect(flags).toMatch(/\[FF_PILOT_ESTIMATE_RECOVERY\]:\s*false/);
    expect(flags).toMatch(/\[FF_PILOT_LINK_ON_ONEPAGER\]:\s*false/);
    expect(flags).toMatch(/\[FF_PILOT_ESTIMATE_SMS\]:\s*false/);
    expect(flags).toMatch(/\[FF_PROTOTYPE_GALLERY\]:\s*false/);
    expect(flags).not.toMatch(/VITE_FF/);
    expect(main).not.toMatch(/GalleryApp/);
    expect(main).not.toMatch(/fixture-brand/);
    expect(main).not.toMatch(/PrototypeWatermark/);
    expect(galleryGate).toMatch(/import\(\s*['"]\.\/GalleryApp\.jsx['"]\s*\)/);
    expect(galleryGate).not.toMatch(/fixture-brand/);
    expect(galleryGate).not.toMatch(/EstimateRecovery/);
  });

  it('keeps the fixture out of the main chunk', () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'ff-demo-'));
    const scriptPath = path.join(outDir, 'build-check.mjs');
    const viteEntry = pathToFileURL(path.join(webRoot, 'node_modules/vite/dist/node/index.js')).href;
    const built = path.join(outDir, 'dist');
    writeFileSync(scriptPath, `
      import { build } from ${JSON.stringify(viteEntry)};
      await build({
        configFile: ${JSON.stringify(path.join(webRoot, 'vite.config.js'))},
        root: ${JSON.stringify(webRoot)},
        mode: 'production',
        logLevel: 'error',
        build: { outDir: ${JSON.stringify(built)}, emptyOutDir: true },
      });
    `);
    try {
      const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `vite build exited ${result.status}`);
      }
      const html = readFileSync(path.join(built, 'index.html'), 'utf8');
      const entrySrc = html.match(/src="([^"]+\.js)"/);
      expect(entrySrc).toBeTruthy();
      const entryName = entrySrc[1].split('/').pop();
      const assetDir = path.join(built, 'assets');
      const names = readdirSync(assetDir).filter(name => name.endsWith('.js'));
      const files = names.map(name => ({
        name,
        text: readFileSync(path.join(assetDir, name), 'utf8'),
      }));
      const entry = files.find(file => file.name === entryName);
      expect(entry, names.join(', ')).toBeTruthy();
      expect(entry.text).not.toContain('Example Heating & Air');
      expect(entry.text).not.toContain('Is there financing?');
      expect(entry.text).not.toContain('TEST: Wasatch Heating');
      expect(entry.text).not.toContain('PROTOTYPE, not live');
      const fixture = files.find(file => file.text.includes('Example Heating & Air'));
      expect(fixture, names.join(', ')).toBeTruthy();
      expect(fixture.name).not.toBe(entry.name);
      expect(fixture.text).toContain('Is there financing?');
      const gallery = files.find(file => file.text.includes('TEST: Wasatch Heating'));
      expect(gallery, names.join(', ')).toBeTruthy();
      expect(gallery.name).not.toBe(entry.name);
      expect(gallery.text).toContain('PROTOTYPE, not live');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
