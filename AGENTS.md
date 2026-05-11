# AGENTS.md

## Cursor Cloud specific instructions

- Service map: this repo runs a single Node.js service (`api/server.js`) that also serves the static frontend from `public/`; use `npm run dev` for local development (`package.json` scripts).
- Runtime dependency caveat: the API exits immediately when `DATABASE_URL` is missing (`[FATAL] DATABASE_URL não definida`), so local service startup always depends on a reachable Postgres/Supabase URL.
- Non-obvious startup caveat: with this codebase, early bootstrap background checks can saturate the default low DB pool and make auth/data endpoints appear to hang even when `/api/health` is up; in Cursor Cloud use `PG_POOL_MAX=10 npm run dev` to keep login/data routes responsive.
- For standard environment variable setup details, follow `README.md` ("Desenvolvimento Local" + Supabase credential sections) instead of duplicating setup steps here.
