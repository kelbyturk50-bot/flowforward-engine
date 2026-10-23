import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __FF_VERCEL_ENV__: JSON.stringify(process.env.VERCEL_ENV ?? ''),
  },
  build: {
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes('Campaigns'));
      },
    },
  },
});
