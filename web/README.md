# FlowForward CRM

Vite + React app in `web/`. The API client is `src/api.js`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/
npm test         # Vitest, one shot (no watch)
npm run lint     # ESLint
```

`npm test` uses jsdom and React Testing Library. Component tests load `src/test/mock-api.js` in place of `src/api.js`, and `fetch` throws if one of those tests tries to leave the process. `api-resolution.test.js` imports the real client and stubs `fetch`. Do not point tests at a real API or put credentials in fixtures.

## API address

The client in `src/api.js` resolves a base URL in this order:

1. **Settings on this device.** `localStorage` key `ff.apiUrl`, written only when you save Settings. It is the address you typed, and it overrides everything below on that origin. Previews do not get an address filled in, so a preview reaches an API (including production) only after you type one and save. A blank save deletes the key.
2. **`VITE_API_URL`.** When the build set it, this wins over the defaults below.
3. **Dev.** `vite` dev (`import.meta.env.DEV`) uses `http://localhost:3000`, the API's default port (`PORT` or 3000).
4. **Production hosts.** A production build uses the production Railway API only when `location.hostname` is exactly one of:
   - `flowforward-engine-six.vercel.app`
   - `flowforward-engine-turk11.vercel.app`
   - `flowforward-engine-git-main-turk11.vercel.app`

   Comparison is exact string equality. A longer name, a prefix, or an extra suffix does not match.
5. **Anything else.** Preview deployments and unknown hosts show **API not configured for this environment** and do not call `fetch`.

Preview deployments cannot reach an API until a staging API exists and `VITE_API_URL` is set for those builds, or someone types an address in Settings. The per-deployment `*.vercel.app` hostname is not a production host.
