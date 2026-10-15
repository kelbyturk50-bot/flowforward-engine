# FlowForward CRM

Vite + React app in `web/`. The API client is `src/api.js`.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # output in dist/
npm test         # Vitest, one shot (no watch)
npm run lint     # ESLint
```

`npm test` uses jsdom and React Testing Library. It loads `src/test/mock-api.js` in place of `src/api.js`, and `fetch` throws if anything tries to leave the test. Do not point tests at a real API or put credentials in fixtures.
