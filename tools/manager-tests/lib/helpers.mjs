// Shared test helpers: account registration, organizations, the official Bitwarden CLI and the browser
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { ROOT, WORK, MANAGER_JS, CHROMIUM_PATH } from "./env.mjs";

const require = createRequire(path.join(ROOT, "package.json"));
export const c = await import(path.join(MANAGER_JS, "bwcrypto.js"));
export const apiMod = await import(path.join(MANAGER_JS, "api.js"));
export const vaultMod = await import(path.join(MANAGER_JS, "vault.js"));
export const hashwasm = require("hash-wasm");
export const kdbxweb = require("kdbxweb");

// The manager expects these libraries as globals, like the browser build
globalThis.hashwasm = hashwasm;
globalThis.kdbxweb = kdbxweb;
c.setArgon2Implementation((pw, salt, mem, it, par, len) =>
    hashwasm.argon2id({ password: pw, salt, memorySize: mem, iterations: it, parallelism: par, hashLength: len, outputType: "binary" }),
);
kdbxweb.CryptoEngine.setArgon2Impl(async (pw, salt, mem, it, len, par, type) => {
    const fn = type === 0 ? hashwasm.argon2d : hashwasm.argon2id;
    const out = await fn({ password: new Uint8Array(pw), salt: new Uint8Array(salt), memorySize: mem, iterations: it, parallelism: par, hashLength: len, outputType: "binary" });
    return out.buffer;
});

let failures = 0;
export function assert(cond, msg) {
    if (!cond) {
        failures++;
        throw new Error(`ASSERTION FAILED: ${msg}`);
    }
    console.log(`  ok - ${msg}`);
}

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function rsaKeyPair() {
    const kp = await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
        true,
        ["encrypt", "decrypt"],
    );
    return {
        pkcs8: new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)),
        spki: new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)),
    };
}

// Registers an account the same way the Bitwarden clients do
export async function register(base, email, password, kdf = { kdf: 0, kdfIterations: 600000 }) {
    const masterKey = await c.deriveMasterKey(password, email, kdf);
    const hash = await c.hashMasterKey(masterKey, password);
    const userKey = c.SymmetricKey.generate();
    const encUserKey = await c.encryptBytes(userKey.raw, await c.stretchMasterKey(masterKey));
    const { pkcs8, spki } = await rsaKeyPair();
    const vres = await fetch(`${base}/identity/accounts/register/send-verification-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/plain" },
        body: JSON.stringify({ email, name: email.split("@")[0] }),
    });
    if (!vres.ok) throw new Error(`verification failed ${vres.status} ${await vres.text()}`);
    const res = await fetch(`${base}/identity/accounts/register/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            email,
            emailVerificationToken: (await vres.text()).replace(/^"|"$/g, ""),
            name: email.split("@")[0],
            masterPasswordHash: hash,
            masterPasswordHint: null,
            key: encUserKey,
            kdf: kdf.kdf,
            kdfIterations: kdf.kdfIterations,
            kdfMemory: kdf.kdfMemory ?? null,
            kdfParallelism: kdf.kdfParallelism ?? null,
            keys: { publicKey: c.b64encode(spki), encryptedPrivateKey: await c.encryptBytes(pkcs8, userKey) },
        }),
    });
    if (!res.ok) throw new Error(`register failed ${res.status} ${await res.text()}`);
    return { publicKey: c.b64encode(spki) };
}

// Logs in with the manager's own Api/Vault classes (outside the browser)
export async function login(base, email, password) {
    const api = new apiMod.Api(base, { deviceId: crypto.randomUUID() });
    const { kdf, hash } = await vaultMod.Vault.preparePasswordLogin(api, email, password);
    const tok = await api.loginPassword(email, hash);
    const vault = new vaultMod.Vault(api);
    await vault.unlock(email, password, tok.Key, kdf);
    await vault.sync();
    return { api, vault, hash };
}

export async function createOrg(vault, name, publicKey) {
    const orgKey = c.SymmetricKey.generate();
    const { pkcs8, spki } = await rsaKeyPair();
    const res = await vault.api.post("/api/organizations", {
        name,
        billingEmail: vault.profile.email,
        collectionName: await c.encryptString("Default collection", orgKey),
        key: await c.rsaEncrypt(orgKey.raw, publicKey),
        keys: { publicKey: c.b64encode(spki), encryptedPrivateKey: await c.encryptBytes(pkcs8, orgKey) },
        planType: 0,
    });
    await vault.sync();
    return res.id;
}

// Wrapper around the official Bitwarden CLI (@bitwarden/cli), used to prove compatibility
export class BwCli {
    constructor(base, name) {
        this.dir = path.join(WORK, "bw", name);
        fs.rmSync(this.dir, { recursive: true, force: true });
        fs.mkdirSync(this.dir, { recursive: true });
        this.env = { ...process.env, BITWARDENCLI_APPDATA_DIR: this.dir, BW_NOINTERACTION: "true", NODE_NO_WARNINGS: "1" };
        // The CLI only talks to the local test server, and it does not honor NO_PROXY
        for (const k of Object.keys(this.env)) {
            if (/^(https?|all)_proxy$/i.test(k)) delete this.env[k];
        }
        this.session = null;
        this.run(["config", "server", base]);
    }

    run(args) {
        const full = this.session ? [...args, "--session", this.session] : args;
        try {
            return execFileSync(path.join(ROOT, "node_modules/.bin/bw"), [...full, "--nointeraction"], {
                env: this.env,
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
        } catch (e) {
            throw new Error(`bw ${args.join(" ")} failed: ${e.stderr || e.message}`);
        }
    }

    json(args) {
        return JSON.parse(this.run(args));
    }

    login(email, password) {
        this.session = this.run(["login", email, password, "--raw"]);
        this.run(["sync"]);
    }

    outDir(name) {
        const dir = path.join(this.dir, "out", name);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
}

export async function launchBrowser() {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
    // The local test server uses a self-signed certificate
    const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        // HTTP errors the tests provoke on purpose (e.g. "two-step login required") are logged by the browser too
        if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(`console: ${m.text()}`);
    });
    return { browser, context, page, errors };
}

export function screenshotPath(name) {
    const dir = path.join(WORK, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${name}.png`);
}

export async function managerLogin(page, base, email, password) {
    await page.goto(`${base}/manager/`);
    await page.fill("input[type=email]", email);
    await page.fill("input[type=password]", password);
    await page.click("button[type=submit]");
}
