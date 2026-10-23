import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(root, 'src');
const realApi = path.resolve(srcDir, 'api.js');
const mockApi = path.resolve(srcDir, 'test/mock-api.js');

// Redirect app imports of src/api.js onto the mock. Scoped to files under src/
// so dependencies are left alone. `vite build` does not load this config.
function mockApiPlugin() {
  return {
    name: 'mock-crm-api',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.startsWith(srcDir + path.sep)) return null;
      if (source !== './api' && source !== '../api' && source !== './api.js' && source !== '../api.js') return null;
      const resolved = path.resolve(path.dirname(importer), source);
      const withJs = resolved.endsWith('.js') ? resolved : `${resolved}.js`;
      if (withJs === realApi) return mockApi;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [mockApiPlugin(), react()],
  define: {
    __FF_VERCEL_ENV__: JSON.stringify(process.env.VERCEL_ENV ?? ''),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    css: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      '**/e2e/**',
    ],
  },
});
