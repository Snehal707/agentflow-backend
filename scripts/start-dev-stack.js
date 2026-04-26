const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const { cleanupExistingStack } = require("./stack-cleanup");

const repoRoot = path.resolve(__dirname, "..");
const concurrentlyEntry = path.join(
  path.dirname(require.resolve("concurrently/package.json")),
  "dist",
  "bin",
  "concurrently.js",
);
dotenv.config({ path: path.join(repoRoot, ".env") });

const commands = [
  "npm run dev:facilitator",
  "npm run dev:research",
  "npm run dev:analyst",
  "npm run dev:writer",
  "npx cross-env EMBEDDED_AGENT_SERVERS=false tsx server.ts",
  "npm run dev:hermes",
  "npm run dev:swap",
  "npm run dev:vault",
  "npm run dev:bridge",
  "npm run dev:portfolio",
  "npm run dev:invoice",
  "npm run dev:vision",
  "npm run dev:transcribe",
  "npm run dev:schedule",
  "npm run dev:split",
  "npm run dev:batch",
  "npm run dev:bot",
];

/**
 * Next.js is started outside concurrently. On Windows, the concurrently parent
 * often exits with code 4294967295 while children die — which took down the
 * frontend on :3005. A sibling process keeps the dev server alive when that happens.
 */
function startFrontend() {
  const mode = (process.env.AGENTFLOW_FRONTEND_MODE || "stable").toLowerCase();
  const hasBuild = fs.existsSync(path.join(repoRoot, "agentflow-frontend", ".next", "BUILD_ID"));
  const useDev = mode === "dev" || !hasBuild;
  const args = useDev
    ? ["run", "dev", "--prefix", "agentflow-frontend"]
    : ["run", "start:3005", "--prefix", "agentflow-frontend"];

  if (!useDev) {
    console.log("[dev:stack] frontend mode: stable production build");
  } else if (!hasBuild && mode !== "dev") {
    console.warn(
      "[dev:stack] no frontend build found; falling back to next dev. Run `npm run build --prefix agentflow-frontend` for faster navigation.",
    );
  } else {
    console.log("[dev:stack] frontend mode: next dev");
  }

  // `next start` must see NODE_ENV=production so next.config.mjs uses distDir
  // `.next`. If repo `.env` sets NODE_ENV=development, stable mode would still run
  // `next start` but Next would look for a build in `.next-dev` and fail.
  const feEnv = useDev
    ? process.env
    : { ...process.env, NODE_ENV: "production" };

  // shell: true avoids spawn EINVAL on Windows when invoking npm
  return spawn("npm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: feEnv,
    shell: true,
  });
}

const feChild = (() => {
  console.log("[dev:stack] cleaning stale AgentFlow listeners and processes...");
  cleanupExistingStack();
  console.log("[dev:stack] starting full stack...");
  console.log(
    "[dev:stack] Frontend: http://localhost:3005 (quick health: http://localhost:3005/api/health)",
  );

  const fe = startFrontend();
  fe.on("error", (err) => {
    console.error("[dev:stack] failed to spawn frontend:", err.message);
  });
  fe.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dev:stack] frontend server killed (${signal})`);
    } else if (code !== 0) {
      console.error(`[dev:stack] frontend server exited with code ${code}`);
    }
  });
  return fe;
})();

const child = spawn(
  process.execPath,
  [
    concurrentlyEntry,
    "-n",
    "f,r,a,w,api,hb,sw,v,br,po,inv,vis,tr,sa,sp,bt,tg",
    "-c",
    "blue,green,yellow,magenta,cyan,blue,red,white,gray,black,cyan,blue,green,magenta,cyan,yellow,magenta",
    ...commands,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  },
);

function shutdown(signal) {
  if (feChild && !feChild.killed) {
    feChild.kill(signal);
  }
  if (child && !child.killed) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[dev:stack] backend stack killed (${signal})`);
    process.exit(1);
    return;
  }
  if (code !== 0 && code !== null) {
    console.warn(
      `[dev:stack] concurrently exited with code ${code} (common on Windows). API/agents may have stopped; Next.js on :3005 is often still running.`,
    );
  }
  // Keep this process alive so the sibling Next.js dev server keeps running.
});
