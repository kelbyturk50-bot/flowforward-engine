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

1. **Settings on this device.** `localStorage` key `ff.apiUrl`, written only when you change the address and save. Leaving the prefilled address stores nothing, so a later default still applies. The stored address must be `https`, except `http` for `localhost` or `127.0.0.1`, and it cannot include a username or password. A stored value that fails that check is ignored. Clear the field and save, or choose Reset, to remove the key. A valid saved address overrides everything below on that origin. Previews do not get an address filled in, so a preview reaches an API only after you type one and save.
2. **`VITE_API_URL`.** Used only when it passes the same check. Any other value is ignored, and resolution continues. A valid value wins over the defaults below.
3. **Dev.** `vite` dev (`import.meta.env.DEV`) uses `http://localhost:3000`, the API's default port (`PORT` or 3000).
4. **Production hosts.** A production build uses the production Railway API only when the page is `https:` on the default port (`location.port` is `''`, which is also what the browser reports for an explicit `:443`) and `location.hostname` is exactly one of:
   - `flowforward-engine-six.vercel.app`
   - `flowforward-engine-turk11.vercel.app`
   - `flowforward-engine-git-main-turk11.vercel.app`

   Comparison is exact string equality. A longer name, a prefix, or an extra suffix does not match. `https://<host>:444/` and `http://<host>/` do not match, show the banner, and do not call `fetch`.
5. **Anything else.** Preview deployments and unknown hosts show **API not configured for this environment** and do not call `fetch`.

Preview deployments cannot reach an API until a staging API exists and `VITE_API_URL` is set for those builds, or someone types an address in Settings. The per-deployment `*.vercel.app` hostname is not a production host.

## Estimate-recovery demo

The pilot walkthrough at `/demo/estimate-recovery/:token` is off unless the page is allowed to read `?flags=`. Defaults in the build are off. Production CRM hostnames never honor the query. Local `npm run dev` (`localhost`) does. The host check reuses `PRODUCTION_HOSTS` in `src/api-base.js`.

QA on a Vercel preview:

`?flags=FF_PILOT_ESTIMATE_RECOVERY,FF_PILOT_LINK_ON_ONEPAGER`

`FF_PILOT_LINK_ON_ONEPAGER` adds **Try a live demo** next to one-pager links in this app. **Preview demo** on Proposals needs only the master flag. The public `/p/:slug` page is rendered by the API, not this app.
