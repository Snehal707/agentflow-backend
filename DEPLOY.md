# Deploying AgentFlow (Railway, Nixpacks, Docker)

The project depends on a **private npm registry** (Cloudsmith) for `@circlefin/x402-batching`. The build will fail with **E401** unless the registry token is available during install.

## Required: set `CLOUDSMITH_TOKEN` at build time

### Railway

1. Open your project → **Variables**.
2. Add a variable:
   - **Name:** `CLOUDSMITH_TOKEN`
   - **Value:** your Cloudsmith token (from Circle / your team).
3. Ensure it is available at **build** time:
   - In Railway, variables are usually used for both build and runtime. If your platform has separate “Build” and “Runtime” variables, set `CLOUDSMITH_TOKEN` for **Build** (or both).

Without this, `npm ci` fails with:

```text
npm error code E401
npm error Incorrect or missing password.
```

### Other platforms (Render, Fly.io, etc.)

- Set the **CLOUDSMITH_TOKEN** environment variable so it is present when the build runs (e.g. when `npm ci` or `npm install` runs).
- Use the platform’s “Build environment variables” or “Secret env vars” and avoid committing the token.

### Local / CI

- Export before install: `export CLOUDSMITH_TOKEN=your_token` then `npm ci`.
- Or use the repo’s setup script so `.env` is loaded: `npm run setup` (see README).

## Railway: backend for Vercel frontend

For the **agentflow-backend** service (used by the Vercel frontend):

1. **Start command:** The repo uses `"start": "tsx ui/server.ts"` in `package.json`. Railway runs `npm start` by default, so the UI server (with `/deposit`, `/run`, `/gateway-balance`) will start.
2. **Port:** The app listens on `process.env.PORT || process.env.UI_PORT || 4000`. Railway sets `PORT`; in **Networking** set the exposed port to match (e.g. 4000).
3. **Variables:** Set `CLOUDSMITH_TOKEN`, `PRIVATE_KEY`, `SELLER_ADDRESS`, and Hermes keys. The frontend calls this service at `NEXT_PUBLIC_BACKEND_URL` (your Railway public URL).

If the Vercel app shows "Failed to fetch" on Deposit, confirm https://your-backend.up.railway.app/health returns `{"status":"ok"}`.

## Optional: root vs `web/` only

- **Full stack (root):** Deploying the repo root runs `npm ci` at root; that’s where `@circlefin/x402-batching` is required, so **CLOUDSMITH_TOKEN** must be set for that build.
- **Frontend only (`web/`):** If you deploy only the `web/` Next.js app (e.g. to Vercel), the root private deps are not used; you only need `NEXT_PUBLIC_BACKEND_URL` pointing at your backend. No **CLOUDSMITH_TOKEN** needed for that build.
