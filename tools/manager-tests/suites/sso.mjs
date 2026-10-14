// SSO and SSO_ONLY: the server refuses every master password based path, the manager logs in with SSO
import { vaultMod, register, login, assert, launchBrowser, screenshotPath } from "../lib/helpers.mjs";
import { startServer, SSO_PORT, OIDC_PORT } from "../lib/env.mjs";
import { startMockOidc } from "../lib/mock-oidc.mjs";

const email = "sso-user@example.com";
const password = "sso user master password";

export async function run() {
    const idp = await startMockOidc(OIDC_PORT);
    idp.setUser({ sub: "sso-sub-1", email });
    const ssoEnv = {
        SSO_ENABLED: "true",
        SSO_AUTHORITY: idp.issuer,
        SSO_CLIENT_ID: "vaultwarden",
        SSO_CLIENT_SECRET: "secret",
        SSO_SIGNUPS_MATCH_EMAIL: "true",
    };
    let server;
    const restart = async (env, fresh = false) => {
        if (server) await server.stop();
        server = await startServer({ port: SSO_PORT, name: "sso", env: { ...ssoEnv, ...env }, fresh });
        return server.base;
    };
    const token = async (base, form) => {
        const res = await fetch(`${base}/identity/connect/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ scope: "api offline_access", client_id: "web", deviceType: "14", deviceIdentifier: crypto.randomUUID(), deviceName: "test", ...form }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ssoLogin = async (page, base) => {
        await page.goto(`${base}/manager/`);
        await page.click("text=Log in with single sign-on (SSO)");
        await page.waitForSelector("text=Your vault is locked", { timeout: 60000 });
        await page.fill("input[type=password]", password);
        await page.click("button[type=submit]");
        await page.waitForSelector(".main-view", { timeout: 60000 });
    };

    const { browser, page, errors } = await launchBrowser();
    try {
        console.log("\n--- SSO enabled, password login still allowed ---");
        let base = await restart({ SSO_ONLY: "false" }, true);
        await register(base, email, password);
        const { vault, api, hash } = await login(base, email, password);
        const seed = vaultMod.newCipherView(1, null);
        seed.name = "Seeded before SSO";
        seed.login.username = "seed";
        seed.login.password = "seed-pw";
        await vault.saveCipher(seed);
        const apiKey = await api.post("/api/accounts/api-key", { masterPasswordHash: hash });
        const cfgA = await (await fetch(`${base}/manager/config.json`)).json();
        assert(cfgA.ssoEnabled && !cfgA.ssoOnly, "config.json: SSO enabled, not only");
        await ssoLogin(page, base);
        assert((await page.locator(".et-row", { hasText: "Seeded before SSO" }).count()) === 1, "manager: SSO login + master password unlock, existing account linked");

        console.log("\n--- SSO only ---");
        // A (dummy) SMTP server enables the e-mail 2FA endpoints, so their SSO_ONLY check is exercised
        base = await restart({ SSO_ONLY: "true", SMTP_HOST: "127.0.0.1", SMTP_PORT: "2525", SMTP_FROM: "vw@example.com", SMTP_SECURITY: "off" });
        assert((await (await fetch(`${base}/manager/config.json`)).json()).ssoOnly, "config.json: SSO only");
        const pw = await token(base, { grant_type: "password", username: email, password: hash });
        assert(pw.status === 400 && JSON.stringify(pw.body).includes("SSO sign-in is required"), "password grant refused");
        const wrong = await token(base, { grant_type: "password", username: email, password: "wrong" });
        assert(JSON.stringify(wrong.body) === JSON.stringify(pw.body), "same answer for a wrong password (no password oracle)");
        const mail = async (address) =>
            (await fetch(`${base}/api/two-factor/send-email-login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: address, masterPasswordHash: hash }),
            }).then((r) => r.text()));
        const mailText = await mail(email);
        assert(mailText.includes("SSO sign-in is required"), "e-mail 2FA endpoint refuses master password hashes");
        assert((await mail("nobody@example.com")) === mailText, "same answer for unknown users (no user enumeration)");
        const reg = await fetch(`${base}/identity/accounts/register/send-verification-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "new@example.com", name: "x" }),
        });
        assert(reg.status === 400, "registration with a master password refused");
        const keyLogin = await token(base, { grant_type: "client_credentials", client_id: `user.${vault.userId}`, client_secret: apiKey.apiKey, scope: "api" });
        assert(keyLogin.status === 200, "personal API key login allowed by default");

        await page.evaluate(() => sessionStorage.clear());
        await page.goto(`${base}/manager/`);
        await page.waitForSelector("text=only allows logging in through single sign-on");
        assert((await page.locator("input[type=password]").count()) === 0, "manager only offers SSO");
        await page.screenshot({ path: screenshotPath("10-sso-only") });
        await ssoLogin(page, base);
        assert((await page.locator(".et-row", { hasText: "Seeded before SSO" }).count()) === 1, "manager: SSO only login");
        const refreshed = await page.evaluate(async () => {
            const a = window.vwManager.api;
            a.tokens.expires_at = 0;
            await a.get("/api/accounts/revision-date");
            return !!a.tokens.access_token;
        });
        assert(refreshed, "manager: SSO session refresh");

        console.log("\n--- SSO only, API key disabled ---");
        base = await restart({ SSO_ONLY: "true", SSO_ONLY_ALLOW_API_KEY: "false" });
        const keyLogin2 = await token(base, { grant_type: "client_credentials", client_id: `user.${vault.userId}`, client_secret: apiKey.apiKey, scope: "api" });
        assert(keyLogin2.status === 400 && JSON.stringify(keyLogin2.body).includes("SSO sign-in is required"), "personal API key login refused");
        const keyLoginBad = await token(base, { grant_type: "client_credentials", client_id: `user.${crypto.randomUUID()}`, client_secret: "nope", scope: "api" });
        assert(JSON.stringify(keyLoginBad.body) === JSON.stringify(keyLogin2.body), "same answer for an unknown API key (no oracle)");
        assert(errors.length === 0, `no browser errors (${errors.join(" | ")})`);
    } finally {
        await browser.close();
        await server?.stop();
        await idp.stop();
    }
}
