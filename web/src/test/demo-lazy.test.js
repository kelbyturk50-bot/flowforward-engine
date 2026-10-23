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
    expect(flags).toMatch(/\[FF_LIVE_CHAT_DEMO\]:\s*false/);
    expect(flags).toMatch(/\[FF_CAMPAIGNS\]:\s*false/);
    expect(flags).not.toMatch(/VITE_FF/);
    expect(main).not.toMatch(/GalleryApp/);
    expect(main).not.toMatch(/fixture-brand/);
    expect(main).not.toMatch(/PrototypeWatermark/);
    const watermark = readFileSync(path.join(webRoot, 'src/components/PrototypeWatermark.jsx'), 'utf8');
    const galleryApp = readFileSync(path.join(webRoot, 'src/prototypes/GalleryApp.jsx'), 'utf8');
    const fonts = readFileSync(path.join(webRoot, 'src/fonts.js'), 'utf8');
    expect(main).toMatch(/import ['"]\.\/fonts\.js['"]/);
    expect(fonts).toContain("import '@fontsource/barlow/latin-400.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-ext-400.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-500.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-ext-500.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-600.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-ext-600.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-700.css'");
    expect(fonts).toContain("import '@fontsource/barlow/latin-ext-700.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-500.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-ext-500.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-600.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-ext-600.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-700.css'");
    expect(fonts).toContain("import '@fontsource/barlow-semi-condensed/latin-ext-700.css'");
    expect(watermark).not.toContain("import '@fontsource/barlow/latin-600.css'");
    expect(watermark).toContain("import '../prototypes/barlow-600.css'");
    expect(galleryApp).not.toContain('fontsource');
    expect(galleryGate).toMatch(/import\(\s*['"]\.\/GalleryApp\.jsx['"]\s*\)/);
    expect(galleryGate).not.toMatch(/fixture-brand/);
    expect(galleryGate).not.toMatch(/EstimateRecovery/);

    const app = readFileSync(path.join(webRoot, 'src/App.jsx'), 'utf8');
    expect(app).toMatch(/lazy\(\(\)\s*=>\s*import\(\s*['"]\.\/views\/Campaigns['"]\s*\)\)/);
    expect(app).not.toMatch(/from ['"]\.\/views\/Campaigns['"]/);
    expect(app).not.toMatch(/\/api\/campaigns/);
    expect(app).not.toMatch(/TEST: HVAC-Oct/);
    const campaignsView = readFileSync(path.join(webRoot, 'src/views/Campaigns.jsx'), 'utf8');
    expect(campaignsView).toMatch(/from ['"]\.\.\/campaigns\/client['"]/);
    expect(campaignsView).toMatch(/from ['"]\.\.\/campaigns\/fixture['"]/);
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
      expect(html).not.toContain('fonts.googleapis.com');
      expect(html).not.toContain('fonts.gstatic.com');
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
      expect(entry.text).not.toContain('/api/campaigns');
      expect(entry.text).not.toContain('TEST: HVAC-Oct');
      expect(entry.text).not.toContain('Sample Home Services');
      expect(entry.text).not.toContain("I'm an AI receptionist demo");
      const campaigns = files.find((file) => file.text.includes('/api/campaigns') && file.text.includes('TEST: HVAC-Oct'));
      expect(campaigns, names.join(', ')).toBeTruthy();
      expect(campaigns.name).not.toBe(entry.name);
      expect(html).not.toContain(campaigns.name);
      const fixture = files.find(file => file.text.includes('Example Heating & Air'));
      expect(fixture, names.join(', ')).toBeTruthy();
      expect(fixture.name).not.toBe(entry.name);
      expect(fixture.text).toContain('Is there financing?');
      const gallery = files.find(file => file.text.includes('TEST: Wasatch Heating'));
      expect(gallery, names.join(', ')).toBeTruthy();
      expect(gallery.name).not.toBe(entry.name);
      const liveChat = files.find((file) => file.text.includes('Sample Home Services') && file.text.includes("I'm an AI receptionist demo"));
      expect(liveChat, names.join(', ')).toBeTruthy();
      expect(liveChat.name).not.toBe(entry.name);
      const watermark = files.find(file => file.text.includes('PROTOTYPE, not live'));
      expect(watermark, names.join(', ')).toBeTruthy();
      expect(watermark.name).not.toBe(entry.name);
      const cssHref = html.match(/href="([^"]+\.css)"/);
      expect(cssHref).toBeTruthy();
      const entryCssName = cssHref[1].split('/').pop();
      const cssNames = readdirSync(assetDir).filter(name => name.endsWith('.css'));
      for (const name of cssNames) {
        const text = readFileSync(path.join(assetDir, name), 'utf8');
        expect(text, name).not.toContain('fonts.googleapis.com');
        expect(text, name).not.toContain('fonts.gstatic.com');
      }
      const entryCss = readFileSync(path.join(assetDir, entryCssName), 'utf8');
      for (const face of [
        'barlow-latin-400-normal',
        'barlow-latin-ext-400-normal',
        'barlow-latin-500-normal',
        'barlow-latin-ext-500-normal',
        'barlow-latin-600-normal',
        'barlow-latin-ext-600-normal',
        'barlow-latin-700-normal',
        'barlow-latin-ext-700-normal',
        'barlow-semi-condensed-latin-500-normal',
        'barlow-semi-condensed-latin-ext-500-normal',
        'barlow-semi-condensed-latin-600-normal',
        'barlow-semi-condensed-latin-ext-600-normal',
        'barlow-semi-condensed-latin-700-normal',
        'barlow-semi-condensed-latin-ext-700-normal',
      ]) {
        expect(entryCss, face).toContain(face);
      }
      expect(entry.text).not.toContain('fonts.googleapis.com');
      expect(entry.text).not.toContain('fonts.gstatic.com');
      const prototypeCss = cssNames
        .filter(name => name !== entryCssName)
        .map(name => ({ name, text: readFileSync(path.join(assetDir, name), 'utf8') }))
        .find(file => file.text.includes('barlow-latin-600-normal'));
      expect(prototypeCss, cssNames.join(', ')).toBeTruthy();
      expect(readdirSync(assetDir).some(name => name.includes('barlow-latin-600-normal') && name.endsWith('.woff2'))).toBe(true);
      expect(readdirSync(assetDir).some(name => name.includes('barlow-latin-ext-600-normal') && name.endsWith('.woff2'))).toBe(true);
      expect(readdirSync(assetDir).some(name => name.includes('barlow-semi-condensed-latin-600-normal') && name.endsWith('.woff2'))).toBe(true);
      expect(readdirSync(assetDir).some(name => name.includes('barlow-semi-condensed-latin-ext-600-normal') && name.endsWith('.woff2'))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
