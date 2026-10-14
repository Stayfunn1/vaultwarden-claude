// Test environment: temporary work dir, self-signed certificate, Vaultwarden server processes
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(ROOT, "../..");
export const MANAGER_JS = path.join(REPO, "src/static/manager/js");

export const WORK = process.env.VWM_TEST_WORK || fs.mkdtempSync(path.join(os.tmpdir(), "vwm-tests-"));
export const VW_BIN = path.resolve(process.env.VW_BIN || path.join(REPO, "target/debug/vaultwarden"));
export const CHROMIUM_PATH = process.env.CHROMIUM_PATH || undefined;
export const PORT = Number(process.env.VWM_TEST_PORT || 8400);
export const SSO_PORT = PORT + 10;
export const OIDC_PORT = Number(process.env.VWM_TEST_OIDC_PORT || 9400);

export function certPaths() {
    return { cert: path.join(WORK, "tls", "cert.pem"), key: path.join(WORK, "tls", "key.pem") };
}

// The official Bitwarden CLI only talks to HTTPS servers, so the test server uses a self-signed certificate
export function makeCert() {
    const { cert, key } = certPaths();
    if (fs.existsSync(cert)) return cert;
    fs.mkdirSync(path.dirname(cert), { recursive: true });
    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "7",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
    return cert;
}

const servers = new Set();

// Starts Vaultwarden with its own data folder. Returns { base, stop() }
export async function startServer({ port = PORT, name = "main", env = {}, fresh = false } = {}) {
    const dataDir = path.join(WORK, `data-${name}`);
    if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const { cert, key } = certPaths();
    const base = `https://localhost:${port}`;
    const logFile = path.join(WORK, `server-${name}.log`);
    const out = fs.openSync(logFile, "a");
    const proc = spawn(VW_BIN, [], {
        cwd: dataDir, // keep a .env of the repository out of the tests
        stdio: ["ignore", out, out],
        env: {
            ...process.env,
            DATA_FOLDER: dataDir,
            ROCKET_ADDRESS: "127.0.0.1",
            ROCKET_PORT: String(port),
            ROCKET_TLS: `{certs="${cert}",key="${key}"}`,
            DOMAIN: base,
            WEB_VAULT_ENABLED: "false",
            SIGNUPS_ALLOWED: "true",
            LOGIN_RATELIMIT_MAX_BURST: "1000",
            UNAUTHENTICATED_RATELIMIT_MAX_BURST: "1000",
            LOG_LEVEL: "info",
            ...env,
        },
    });
    const exited = new Promise((r) => proc.on("exit", r));
    const server = {
        base,
        logFile,
        async stop() {
            servers.delete(server);
            proc.kill("SIGTERM");
            await exited;
        },
    };
    servers.add(server);
    for (let i = 0; i < 120; i++) {
        if (proc.exitCode !== null) throw new Error(`Vaultwarden exited, see ${logFile}`);
        try {
            if ((await fetch(`${base}/alive`)).ok) return server;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Vaultwarden did not start, see ${logFile}`);
}

export async function stopAll() {
    for (const s of [...servers]) await s.stop();
}
