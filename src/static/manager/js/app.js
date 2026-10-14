// Vaultwarden Manager: a compact, KeePass 2 style vault manager for Vaultwarden.
// All encryption happens in this browser, the server only ever sees encrypted data.

import { Api, ApiError, TwoFactorRequired, TwoFactorType, decodeJwt } from "./api.js";
import { Vault, CipherType, CipherTypeNames, FieldType, cloneView, newCipherView, normalizeFolderPath, parentPath, leafName, isSameOrDescendant, sanitizeSegment } from "./vault.js";
import {
    deriveMasterKey,
    hashMasterKey,
    stretchMasterKey,
    pkcePair,
    randomBytes,
    b64urlEncode,
    b64urlDecode,
    b64encode,
    totpCode,
    pbkdf2,
    utf8,
    encryptString,
    decryptString,
    encryptBytes,
    generateRsaKeyPair,
    SymmetricKey,
} from "./bwcrypto.js";
import {
    h, icon, clear, settings, saveSettings, toast, copyText, clipboardState, showMenu, closeMenus, dialog, confirmDialog, promptDialog,
    alertDialog, progressDialog, isDialogOpen, closeAllDialogs, formatDate, formatBytes, downloadBlob, safeUrl,
} from "./ui.js";
import { TreeView, ciphersForNode, folderKey, collectionKey } from "./tree.js";
import { EntryTable, COLUMNS, typeIcon } from "./table.js";
import { editEntryDialog } from "./editor.js";
import { generatorDialog, importKeePassDialog, shareDialog, collectionsDialog, settingsDialog, shortcutsDialog } from "./dialogs.js";
import { newOrganizationDialog, organizationDialog, collectionAccessDialog, pendingConfirmations } from "./orgs.js";

const SESSION_KEY = "vwm.session";
// Card, identity and SSH key values which are treated like passwords
const SENSITIVE_TYPE_FIELDS = ["number", "code", "ssn", "passportNumber", "licenseNumber", "privateKey"];
const SSO_REQUEST_KEY = "vwm.sso.request";
const SSO_RESULT_KEY = "vwm.sso.result";

const BASE_URL = new URL("../", window.location.href).href.replace(/\/$/, "");
const SSO_REDIRECT = `${BASE_URL}/manager/sso-callback.html`;

function applyTheme() {
    const t = settings.theme;
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
}

function remember2faKey(email) {
    return `vwm.2fa.${email.toLowerCase()}`;
}

class App {
    constructor() {
        this.root = document.getElementById("app");
        this.config = { ssoEnabled: false, ssoOnly: false, webVaultEnabled: true };
        this.api = new Api(BASE_URL);
        this.vault = new Vault(this.api);
        this.session = null; // { email, kdf, key, tokens, sso }
        this.searchText = "";
        this._busy = 0;
        this.repromptPassed = new Set();
        this.lastActivity = Date.now();
        this.lastRevision = null;
        this.api.onTokensChanged = (tokens) => {
            if (this.session) {
                this.session.tokens = tokens;
                this.saveSession();
            }
        };
        this.api.onUnauthorized = () => {
            if (this.session) {
                toast("Your session has expired, please log in again", "warn", 6000);
                this.logout(false);
            }
        };
    }

    // Long running work (sync, bulk operations, imports): no auto-lock and no background sync meanwhile
    get busy() {
        return this._busy > 0 || this.vault.busy;
    }

    beginBusy() {
        this._busy++;
    }

    endBusy() {
        this._busy = Math.max(0, this._busy - 1);
    }

    // ----- Startup & session ---------------------------------------------------------------

    async start() {
        applyTheme();
        try {
            const res = await fetch("config.json");
            if (res.ok) this.config = { ...this.config, ...(await res.json()) };
        } catch {
            /* defaults */
        }
        try {
            this.session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        } catch {
            this.session = null;
        }
        if (this.session?.tokens) this.api.setTokens(this.session.tokens);

        const ssoResult = sessionStorage.getItem(SSO_RESULT_KEY);
        if (ssoResult) {
            sessionStorage.removeItem(SSO_RESULT_KEY);
            await this.finishSso(JSON.parse(ssoResult));
            return;
        }
        if (this.session?.key) this.showUnlock();
        else this.showLogin();
        this.installActivityTracking();
    }

    saveSession() {
        try {
            if (this.session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
            else sessionStorage.removeItem(SESSION_KEY);
        } catch {
            /* storage unavailable */
        }
    }

    // ----- Authentication screens ------------------------------------------------------------

    authFrame(title, ...content) {
        clear(this.root);
        const box = h(
            "div",
            { class: "auth-box" },
            h("div", { class: "auth-logo" }, h("img", { src: "../vw_static/vaultwarden-icon.png", alt: "", width: 48, height: 48 }), h("div", null, h("h1", null, "Vaultwarden Manager"), h("div", { class: "muted" }, title))),
            ...content,
        );
        this.root.appendChild(h("div", { class: "auth-view" }, box));
        return box;
    }

    showLogin(message) {
        this.vault.lock();
        const err = h("div", { class: "form-error", role: "alert" }, message || "");
        const email = h("input", { type: "email", class: "wide", autocomplete: "username", value: settings.email || "", placeholder: "you@example.com" });
        const children = [];
        let password;
        let loginBtn;
        if (!this.config.ssoOnly) {
            password = h("input", { type: "password", class: "wide", autocomplete: "current-password" });
            loginBtn = h("button", { type: "submit", class: "primary wide" }, "Log in");
            children.push(
                h("label", { class: "field" }, h("span", null, "E-mail address"), email),
                h("label", { class: "field" }, h("span", null, "Master password"), password),
                loginBtn,
            );
        } else {
            children.push(h("p", { class: "muted" }, "This server only allows logging in through single sign-on."));
        }
        if (this.config.ssoEnabled) {
            if (!this.config.ssoOnly) children.push(h("div", { class: "or" }, "or"));
            children.push(h("button", { type: "button", class: this.config.ssoOnly ? "primary wide" : "wide", onclick: () => this.startSso() }, "Log in with single sign-on (SSO)"));
        }
        const form = h("form", { class: "auth-form" }, ...children, err);
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            if (!password) return;
            err.textContent = "";
            loginBtn.disabled = true;
            loginBtn.textContent = "Logging in…";
            try {
                await this.passwordLogin(email.value.trim(), password.value);
            } catch (ex) {
                console.error(ex);
                err.textContent = ex.message || String(ex);
                loginBtn.disabled = false;
                loginBtn.textContent = "Log in";
            }
        });
        const links = h(
            "div",
            { class: "auth-links" },
            this.config.webVaultEnabled ? h("a", { href: `${BASE_URL}/#/`, target: "_blank", rel: "noopener" }, "Open the Bitwarden web vault") : "",
        );
        this.authFrame("Log in to your vault", form, links);
        (settings.email && password ? password : email).focus();
    }

    async passwordLogin(email, password) {
        if (!email || !password) throw new Error("Enter your e-mail address and master password");
        const kdf = await this.api.prelogin(email);
        const masterKey = await deriveMasterKey(password, email, kdf);
        const hash = await hashMasterKey(masterKey, password);
        let tokenResponse;
        let remembered = null;
        try {
            remembered = localStorage.getItem(remember2faKey(email));
        } catch {
            /* ignore */
        }
        try {
            tokenResponse = await this.api.loginPassword(email, hash, remembered ? { provider: TwoFactorType.Remember, token: remembered } : null);
        } catch (e) {
            if (!(e instanceof TwoFactorRequired)) throw e;
            if (remembered) localStorage.removeItem(remember2faKey(email));
            const tf = await this.twoFactorDialog(e, { email, masterPasswordHash: hash });
            if (!tf) throw new Error("Two-step login cancelled");
            tokenResponse = tf.response;
        }
        if (settings.rememberEmail) settings.email = email;
        await this.completeLogin(tokenResponse, email, password, masterKey, false);
    }

    async completeLogin(resp, email, password, masterKey, sso) {
        if (resp.TwoFactorToken) {
            try {
                localStorage.setItem(remember2faKey(email), resp.TwoFactorToken);
            } catch {
                /* ignore */
            }
        }
        if (!resp.Key) {
            if (sso) return this.showSetPassword(resp, email);
            throw new Error("Your account has no master password yet. Finish setting up your account in the Bitwarden web vault or app first, then log in here.");
        }
        const kdf = { kdf: resp.Kdf, kdfIterations: resp.KdfIterations, kdfMemory: resp.KdfMemory, kdfParallelism: resp.KdfParallelism };
        this.session = { email, kdf, key: resp.Key, tokens: this.api.tokens, sso };
        this.saveSession();
        if (password) {
            await this.vault.setUserKeyFromMasterKey(masterKey, resp.Key);
            await this.rememberPasswordCheck(masterKey, password);
            await this.openVault();
        } else {
            this.showUnlock();
        }
    }

    // First single sign-on of a new account: choose the master password, which encrypts the vault.
    // The keys are made here like in the Bitwarden clients, the server only gets them encrypted.
    showSetPassword(resp, email) {
        const policy = resp.MasterPasswordPolicy || {};
        const minLength = Math.max(12, Number(policy.minLength) || 0);
        const rules = [
            [`at least ${minLength} characters`, (p) => p.length >= minLength],
            policy.requireUpper ? ["an upper case letter", (p) => /[A-Z]/.test(p)] : null,
            policy.requireLower ? ["a lower case letter", (p) => /[a-z]/.test(p)] : null,
            policy.requireNumbers ? ["a number", (p) => /[0-9]/.test(p)] : null,
            policy.requireSpecial ? ["a special character", (p) => /[^A-Za-z0-9]/.test(p)] : null,
        ].filter(Boolean);
        const err = h("div", { class: "form-error", role: "alert" });
        const password = h("input", { type: "password", class: "wide", autocomplete: "new-password" });
        const repeat = h("input", { type: "password", class: "wide", autocomplete: "new-password" });
        const hint = h("input", { type: "text", class: "wide", autocomplete: "off" });
        const btn = h("button", { type: "submit", class: "primary wide" }, "Set master password");
        const form = h(
            "form",
            { class: "auth-form" },
            h("div", { class: "muted" }, `Welcome ${email}. Choose the master password of your vault. It encrypts all your entries and is never sent to the server, so it can not be reset. Required: ${rules.map((r) => r[0]).join(", ")}.`),
            h("label", { class: "field" }, h("span", null, "Master password"), password),
            h("label", { class: "field" }, h("span", null, "Repeat master password"), repeat),
            h("label", { class: "field" }, h("span", null, "Hint (optional, shown to anyone asking for it)"), hint),
            btn,
            err,
        );
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            err.textContent = "";
            const pw = password.value;
            const missing = rules.filter(([, test]) => !test(pw)).map(([text]) => text);
            if (missing.length) return (err.textContent = `The master password needs ${missing.join(", ")}.`);
            if (pw !== repeat.value) return (err.textContent = "The passwords do not match.");
            if (hint.value && hint.value.trim() === pw) return (err.textContent = "The hint can not be the password.");
            btn.disabled = true;
            btn.textContent = "Setting up…";
            try {
                const kdf = { kdf: 0, kdfIterations: 600000, kdfMemory: null, kdfParallelism: null };
                const masterKey = await deriveMasterKey(pw, email, kdf);
                const userKey = SymmetricKey.generate();
                const key = await encryptBytes(userKey.raw, await stretchMasterKey(masterKey));
                const { pkcs8, spki } = await generateRsaKeyPair();
                await this.api.post("/api/accounts/set-password", {
                    masterPasswordHash: await hashMasterKey(masterKey, pw),
                    masterPasswordHint: hint.value.trim() || null,
                    key,
                    keys: { publicKey: b64encode(spki), encryptedPrivateKey: await encryptBytes(pkcs8, userKey) },
                    ...kdf,
                    orgIdentifier: null,
                });
                await this.completeLogin(
                    { ...resp, Key: key, Kdf: kdf.kdf, KdfIterations: kdf.kdfIterations, KdfMemory: null, KdfParallelism: null },
                    email,
                    pw,
                    masterKey,
                    true,
                );
            } catch (ex) {
                err.textContent = ex.message || String(ex);
                btn.disabled = false;
                btn.textContent = "Set master password";
            }
        });
        this.authFrame("Set up your vault", form);
        password.focus();
    }

    async rememberPasswordCheck(masterKey, password) {
        // Kept in memory only, used for the master password re-prompt
        this.localHash = b64encode(await pbkdf2(masterKey, utf8(password), 2));
    }

    async verifyMasterPassword(password) {
        if (!this.session) return false;
        const masterKey = await deriveMasterKey(password, this.session.email, this.session.kdf);
        return b64encode(await pbkdf2(masterKey, utf8(password), 2)) === this.localHash;
    }

    showUnlock(message) {
        this.vault.lock();
        this.repromptPassed.clear();
        const err = h("div", { class: "form-error", role: "alert" }, message || "");
        const password = h("input", { type: "password", class: "wide", autocomplete: "current-password" });
        const btn = h("button", { type: "submit", class: "primary wide" }, "Unlock");
        const form = h(
            "form",
            { class: "auth-form" },
            h("div", { class: "muted" }, `Logged in as ${this.session.email}${this.session.sso ? " (single sign-on)" : ""}`),
            h("label", { class: "field" }, h("span", null, "Master password"), password),
            btn,
            err,
        );
        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            err.textContent = "";
            btn.disabled = true;
            btn.textContent = "Unlocking…";
            try {
                const masterKey = await deriveMasterKey(password.value, this.session.email, this.session.kdf);
                try {
                    await this.vault.setUserKeyFromMasterKey(masterKey, this.session.key);
                } catch {
                    throw new Error("Invalid master password");
                }
                await this.rememberPasswordCheck(masterKey, password.value);
                await this.openVault();
            } catch (ex) {
                err.textContent = ex.message || String(ex);
                btn.disabled = false;
                btn.textContent = "Unlock";
                password.select();
            }
        });
        const links = h("div", { class: "auth-links" }, h("a", { href: "#", onclick: (e) => {
            e.preventDefault();
            this.logout();
        } }, "Log out"));
        this.authFrame("Your vault is locked", form, links);
        password.focus();
    }

    async startSso() {
        const { verifier, challenge } = await pkcePair();
        const state = `${b64urlEncode(randomBytes(24))}_vwm`;
        sessionStorage.setItem(SSO_REQUEST_KEY, JSON.stringify({ state, verifier }));
        const params = new URLSearchParams({
            client_id: "web",
            redirect_uri: SSO_REDIRECT,
            response_type: "code",
            scope: "api offline_access",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            response_mode: "query",
        });
        window.location.href = `${BASE_URL}/identity/connect/authorize?${params}`;
    }

    async finishSso(result) {
        let request = null;
        try {
            request = JSON.parse(sessionStorage.getItem(SSO_REQUEST_KEY) || "null");
        } catch {
            /* ignore */
        }
        sessionStorage.removeItem(SSO_REQUEST_KEY);
        this.installActivityTracking();
        if (!request || !result.code || result.state !== request.state) {
            this.showLogin("The single sign-on response was invalid or expired, please try again.");
            return;
        }
        this.authFrame("Completing single sign-on…", h("div", { class: "spinner" }));
        try {
            let resp;
            try {
                resp = await this.api.loginSso(result.code, request.verifier, SSO_REDIRECT);
            } catch (e) {
                if (!(e instanceof TwoFactorRequired)) throw e;
                const tf = await this.twoFactorDialog(e, { sso: { code: result.code, verifier: request.verifier } });
                if (!tf) throw new Error("Two-step login cancelled");
                resp = tf.response;
            }
            const claims = decodeJwt(resp.access_token);
            const email = claims.email;
            if (settings.rememberEmail) settings.email = email;
            await this.completeLogin(resp, email, null, null, true);
        } catch (e) {
            console.error(e);
            this.showLogin(e.message || String(e));
        }
    }

    // Asks for the second factor and retries the login. Returns { response } or undefined.
    twoFactorDialog(err, ctx) {
        const supported = [TwoFactorType.Webauthn, TwoFactorType.Authenticator, TwoFactorType.YubiKey, TwoFactorType.Email];
        const providers = supported.filter((p) => err.providers.includes(p));
        const names = { 0: "Authenticator app", 1: "E-mail", 3: "YubiKey OTP", 7: "Security key (FIDO2 / WebAuthn)" };
        return dialog({
            title: "Two-step login",
            width: "440px",
            build: (close) => {
                const body = h("div", { class: "form" });
                const errBox = h("div", { class: "form-error", role: "alert" });
                const remember = h("input", { type: "checkbox" });
                let provider = providers[0];
                let codeInput = null;
                const submit = async (token) => {
                    errBox.textContent = "";
                    const tf = { provider, token: token ?? codeInput?.value.trim(), remember: remember.checked };
                    if (!tf.token) return;
                    try {
                        const response = ctx.sso
                            ? await this.api.loginSso(ctx.sso.code, ctx.sso.verifier, SSO_REDIRECT, tf)
                            : await this.api.loginPassword(ctx.email, ctx.masterPasswordHash, tf);
                        close({ response });
                    } catch (e) {
                        errBox.textContent = e instanceof TwoFactorRequired ? "Invalid code, please try again." : e.message;
                    }
                };
                const sendEmail = async () => {
                    try {
                        const data = ctx.sso
                            ? { email: decodeJwt(this.api.tokens?.access_token || "").email || settings.email || null, deviceIdentifier: this.api.deviceId }
                            : { email: ctx.email, masterPasswordHash: ctx.masterPasswordHash, deviceIdentifier: this.api.deviceId };
                        await this.api.sendEmailLogin(data);
                        toast("Verification code sent", "ok");
                    } catch (e) {
                        errBox.textContent = e.message;
                    }
                };
                const render = () => {
                    clear(body);
                    if (!providers.length) {
                        body.appendChild(h("p", null, "Your account uses a two-step login method that is not supported here (e.g. Duo). Please use the Bitwarden web vault or app."));
                        return;
                    }
                    if (providers.length > 1) {
                        const sel = h("select", { class: "wide" }, providers.map((p) => h("option", { value: String(p), selected: p === provider }, names[p])));
                        sel.addEventListener("change", () => {
                            provider = parseInt(sel.value, 10);
                            render();
                        });
                        body.appendChild(h("label", { class: "field" }, h("span", null, "Method"), sel));
                    }
                    if (provider === TwoFactorType.Webauthn) {
                        const btn = h("button", { type: "button", class: "primary wide" }, "Use security key");
                        btn.addEventListener("click", async () => {
                            try {
                                await submit(await webauthnAssertion(err.providerData[String(TwoFactorType.Webauthn)]));
                            } catch (e) {
                                errBox.textContent = e.message || String(e);
                            }
                        });
                        body.appendChild(h("p", null, "Insert and touch your security key."));
                        body.appendChild(btn);
                    } else {
                        const hint =
                            provider === TwoFactorType.Email
                                ? `Enter the code sent to ${err.providerData["1"]?.Email || "your e-mail address"}.`
                                : provider === TwoFactorType.YubiKey
                                  ? "Insert your YubiKey and touch its button."
                                  : "Enter the 6 digit code from your authenticator app.";
                        codeInput = h("input", { type: "text", class: "wide mono", autocomplete: "one-time-code", inputmode: provider === TwoFactorType.YubiKey ? "text" : "numeric" });
                        body.appendChild(h("p", null, hint));
                        body.appendChild(codeInput);
                        if (provider === TwoFactorType.Email) {
                            body.appendChild(h("button", { type: "button", class: "link-btn", onclick: sendEmail }, "Send the code again"));
                            if (providers.length === 1 || !render.emailSent) {
                                render.emailSent = true;
                                sendEmail();
                            }
                        }
                        setTimeout(() => codeInput.focus(), 0);
                    }
                    body.appendChild(h("label", { class: "check" }, remember, "Remember this device for 30 days"));
                    body.appendChild(errBox);
                };
                render();
                return {
                    body,
                    buttons: [h("button", { type: "button", class: "primary", onclick: () => submit() }, "Continue"), h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                    onEnter: () => submit(),
                };
            },
        });
    }

    async logout(confirm = false) {
        if (confirm && !(await confirmDialog("Log out", "Log out of the vault on this browser tab?", { ok: "Log out" }))) return;
        this.vault.lock();
        this.api.setTokens(null);
        this.session = null;
        this.saveSession();
        this.showLogin();
    }

    lock() {
        if (!this.vault.userKey) return;
        closeMenus();
        // Close open dialogs, their data is about to be wiped
        closeAllDialogs();
        this.localHash = null;
        this.showUnlock();
    }

    installActivityTracking() {
        if (this._activityInstalled) return;
        this._activityInstalled = true;
        const touch = () => (this.lastActivity = Date.now());
        for (const ev of ["mousedown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, touch, { passive: true });
        setInterval(() => {
            const mins = Number(settings.lockMinutes) || 0;
            if (mins > 0 && this.vault.userKey && !this.busy && Date.now() - this.lastActivity > mins * 60_000) {
                this.lock();
                toast("Vault locked after inactivity", "info");
            }
        }, 15_000);
        window.addEventListener("focus", () => this.checkForUpdates());
        setInterval(() => this.checkForUpdates(), 5 * 60_000);
    }

    async checkForUpdates() {
        if (!this.vault.userKey || this.busy || isDialogOpen()) return;
        try {
            const rev = await this.api.get("/api/accounts/revision-date");
            if (this.lastRevision !== null && rev !== this.lastRevision) {
                // Discarded (and retried later) when something was changed here in the meantime
                if (await this.sync(true)) toast("Vault updated from another device", "info");
                return;
            }
            this.lastRevision = rev;
        } catch {
            /* ignore, the next action will report errors */
        }
    }

    // ----- Main window ---------------------------------------------------------------------------

    async openVault() {
        const progress = h("div", { class: "progress-label" }, "Decrypting vault…");
        this.authFrame("Loading…", h("div", { class: "spinner" }), progress);
        await this.vault.sync((done, total) => {
            progress.textContent = `Decrypting vault… ${done} / ${total}`;
        });
        try {
            this.lastRevision = await this.api.get("/api/accounts/revision-date");
        } catch {
            this.lastRevision = null;
        }
        this.buildMain();
        await this.loadTreeState();
        this.refresh();
        this.checkPendingConfirmations();
    }

    // ----- Organizations ---------------------------------------------------------------------------

    // Shows a notice in the status bar when members wait for confirmation in an organization the user manages
    async checkPendingConfirmations() {
        try {
            this.pending = await pendingConfirmations(this.vault);
        } catch {
            this.pending = new Map();
        }
        if (!this.statusNotice) return;
        const total = [...this.pending.values()].reduce((a, b) => a + b, 0);
        this.statusNotice.hidden = total === 0;
        this.statusNotice.textContent = `⚠ ${total} member${total === 1 ? "" : "s"} waiting for confirmation`;
        this.statusNotice.title = [...this.pending].map(([id, n]) => `${this.vault.organizations.get(id)?.name}: ${n}`).join("\n");
    }

    openPendingConfirmations() {
        const orgId = [...(this.pending || new Map()).keys()][0];
        if (orgId) this.manageOrganization(orgId);
    }

    async newOrganization() {
        const id = await newOrganizationDialog(this);
        if (!id) return;
        await this.sync(true);
        toast("Organization created", "ok");
        if (this.tree) this.tree.select(collectionKey(id, ""), true);
    }

    async manageOrganization(orgId, tab) {
        if (!this.vault.orgKeys.has(orgId)) {
            return alertDialog("Organization", "Your membership in this organization is not confirmed yet, so its data can not be decrypted here.");
        }
        const changed = await organizationDialog(this, orgId, tab);
        if (changed) await this.sync(true);
        this.checkPendingConfirmations();
    }

    async collectionAccess(collectionId) {
        if (await collectionAccessDialog(this, collectionId)) await this.sync(true);
    }

    orgMenuItems() {
        const orgs = [...this.vault.organizations.values()].sort((a, b) => a.name.localeCompare(b.name));
        const items = [{ label: "New organization…", icon: "add", action: () => this.newOrganization() }, "-"];
        if (!orgs.length) items.push({ label: "(no organizations)", disabled: true });
        for (const o of orgs) {
            const n = this.pending?.get(o.id);
            items.push({
                label: `${o.name}${n ? ` (${n} to confirm)` : ""}…`,
                icon: "org",
                action: () => this.manageOrganization(o.id),
                disabled: !this.vault.canManageOrg(o.id),
            });
        }
        return items;
    }

    // The expanded folders are remembered per account. Their keys contain folder names, so they are
    // stored encrypted with the account key, like everything else of the vault.
    treeStateKey() {
        return `vwm.tree.${this.vault.userId}`;
    }

    async loadTreeState() {
        try {
            const enc = localStorage.getItem(this.treeStateKey());
            if (enc) this.tree.expanded = JSON.parse(await decryptString(enc, this.vault.userKey)) || {};
        } catch {
            this.tree.expanded = {};
        }
    }

    saveTreeState(expanded) {
        clearTimeout(this._treeSaveTimer);
        this._treeSaveTimer = setTimeout(async () => {
            if (!this.vault.userKey) return;
            try {
                localStorage.setItem(this.treeStateKey(), await encryptString(JSON.stringify(expanded), this.vault.userKey));
            } catch {
                /* storage unavailable */
            }
        }, 500);
    }

    buildMain() {
        clear(this.root);
        this.menubar = this.buildMenubar();
        this.toolbar = this.buildToolbar();
        const treeEl = h("div", { class: "tree-pane" });
        const entriesEl = h("div", { class: "entries-pane" });
        this.detailsEl = h("div", { class: "details-pane" });
        const vSplit = h("div", { class: "splitter-v", title: "Drag to resize" });
        const hSplit = h("div", { class: "splitter-h", title: "Drag to resize" });
        this.rightPane = h("div", { class: "right-pane" }, entriesEl, hSplit, this.detailsEl);
        this.leftPane = h("div", { class: "left-pane", style: { width: `${settings.treeWidth}px` } }, treeEl);
        const workspace = h("div", { class: "workspace" }, this.leftPane, vSplit, this.rightPane);
        this.statusLeft = h("span", { class: "status-left" });
        this.statusRight = h("span", { class: "status-right" });
        this.statusNotice = h("button", { type: "button", class: "status-notice", hidden: true, onclick: () => this.openPendingConfirmations() });
        const status = h("div", { class: "statusbar" }, this.statusLeft, this.statusNotice, this.statusRight);
        this.root.appendChild(h("div", { class: "main-view" }, this.menubar, this.toolbar, workspace, status));
        this.applyDetailsVisibility();
        this.detailsEl.style.height = `${settings.detailsHeight}px`;
        this.makeSplitter(vSplit, "x", (d) => {
            settings.treeWidth = Math.max(140, Math.min(700, settings.treeWidth + d));
            this.leftPane.style.width = `${settings.treeWidth}px`;
        });
        this.makeSplitter(hSplit, "y", (d) => {
            settings.detailsHeight = Math.max(60, Math.min(window.innerHeight - 200, settings.detailsHeight - d));
            this.detailsEl.style.height = `${settings.detailsHeight}px`;
        });

        this.tree = new TreeView(treeEl, {
            onSelect: () => {
                if (this.searchText) this.clearSearch(false);
                this.refreshEntries(false);
            },
            onContext: (node, x, y) => showMenu(this.groupMenuItems(node), x, y),
            canDrop: (node, dt) => this.canDrop(node, dt),
            onDrop: (node, dt) => this.handleDrop(node, dt),
            onDragStartNode: (node) => (this._dragNode = node),
            onExpandedChanged: (expanded) => this.saveTreeState(expanded),
            onRename: (node) => this.renameGroup(node),
            onDelete: (node) => this.deleteGroup(node),
            onAddChild: (node) => this.addGroup(node),
        });
        this.table = new EntryTable(entriesEl, {
            ctx: { groupName: (v) => this.groupName(v), ownerName: (v) => (v.organizationId ? this.vault.organizations.get(v.organizationId)?.name || "" : "Me") },
            onSelect: (views) => this.onSelectionChanged(views),
            onOpen: (v) => this.editEntry(v),
            onContext: (x, y) => showMenu(this.entryMenuItems(), x, y),
            onHeaderContext: (x, y) => showMenu([{ label: "Columns", submenu: this.columnMenuItems() }], x, y),
            onCellDblClick: (v, col) => this.onCellDblClick(v, col),
        });
        clipboardState.onTick = (left) => {
            this.clipStatus = left ? `Clipboard is cleared in ${left}s` : "";
            this.updateStatus();
        };
        if (!this._keysInstalled) {
            this._keysInstalled = true;
            document.addEventListener("keydown", (e) => this.onGlobalKey(e));
        }
        if (!this._totpTimer) this._totpTimer = setInterval(() => this.renderDetailsTotp(), 1000);
    }

    makeSplitter(el, axis, onMove) {
        el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            let last = axis === "x" ? e.clientX : e.clientY;
            const move = (ev) => {
                const cur = axis === "x" ? ev.clientX : ev.clientY;
                onMove(cur - last);
                last = cur;
            };
            const up = () => {
                document.removeEventListener("mousemove", move);
                document.removeEventListener("mouseup", up);
                saveSettings();
                this.table?.renderRows(true);
            };
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
        });
    }

    applyDetailsVisibility() {
        if (this.detailsEl) this.rightPane.classList.toggle("no-details", !settings.showDetails);
    }

    // Re-render tree and entries after data changes
    refresh() {
        if (!this.tree) return;
        this.tree.render(this.vault);
        this.refreshEntries(true);
    }

    refreshEntries(keepSelection = true) {
        let rows;
        let emptyText = "This folder is empty";
        if (this.searchText) {
            const terms = this.searchText.toLowerCase().split(/\s+/).filter(Boolean);
            rows = [...this.vault.ciphers.values()].filter((c) => !c.deletedDate && Vault.matches(c, terms));
            emptyText = "No matching entries";
        } else if (this.duplicateFilter) {
            rows = this.duplicateFilter.map((id) => this.vault.ciphers.get(id)).filter(Boolean);
        } else {
            rows = ciphersForNode(this.vault, this.tree.selected, { includeSubfolders: settings.showSubfolderEntries });
            if (this.tree.selected?.kind === "trash") emptyText = "The trash is empty";
        }
        this.table.showGroupColumn = !!(this.searchText || this.duplicateFilter || settings.showSubfolderEntries || ["favorites", "trash", "archive", "org", "collection"].includes(this.tree.selected?.kind));
        this.table.setRows(rows, { keepSelection, emptyText });
        this.updateStatus();
    }

    groupName(v) {
        if (v.organizationId && v.collectionIds.length && this.tree?.selected?.kind !== "vault" && this.tree?.selected?.kind !== "folder") {
            const names = v.collectionIds.map((id) => this.vault.collections.get(id)?.path).filter(Boolean);
            const org = this.vault.organizations.get(v.organizationId)?.name || "";
            if (names.length) return `${org}: ${names.join(", ")}`;
        }
        const f = v.folderId ? this.vault.folders.get(v.folderId) : null;
        return f ? f.path : "";
    }

    updateStatus() {
        if (!this.statusLeft) return;
        const sel = this.table.selection.size;
        const total = this.table.rows.length;
        const all = [...this.vault.ciphers.values()].filter((c) => !c.deletedDate).length;
        this.statusLeft.textContent = `${sel} of ${total} selected · ${all} entries in total`;
        this.statusRight.textContent = [this.clipStatus, this.searchText ? `Search: "${this.searchText}"` : "", this.session?.email].filter(Boolean).join("  ·  ");
    }

    // ----- Menus -----------------------------------------------------------------------------------

    buildMenubar() {
        const bar = h("div", { class: "menubar", role: "menubar" });
        const menus = [
            ["File", () => this.fileMenuItems()],
            ["Edit", () => this.entryMenuItems(true)],
            ["Group", () => this.groupMenuItems(this.tree?.selected)],
            ["Organizations", () => this.orgMenuItems()],
            ["View", () => this.viewMenuItems()],
            ["Tools", () => this.toolsMenuItems()],
            ["Help", () => this.helpMenuItems()],
        ];
        for (const [label, items] of menus) {
            const el = h("div", { class: "menubar-item", tabindex: "0", role: "menuitem" }, label);
            const open = () => {
                const r = el.getBoundingClientRect();
                showMenu(items(), r.left, r.bottom);
                bar.dataset.open = "1";
            };
            el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                if (document.querySelector(".menu") && bar.dataset.open === label) {
                    closeMenus();
                    bar.dataset.open = "";
                } else {
                    open();
                    bar.dataset.open = label;
                }
            });
            el.addEventListener("mouseenter", () => {
                if (bar.dataset.open && document.querySelector(".menu")) {
                    open();
                    bar.dataset.open = label;
                }
            });
            el.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === "ArrowDown") {
                    e.preventDefault();
                    open();
                }
            });
            bar.appendChild(el);
        }
        return bar;
    }

    buildToolbar() {
        const btn = (iconName, title, action, extra = {}) =>
            h("button", { type: "button", class: "tb-btn", title, "aria-label": title, onclick: action, ...extra }, icon(iconName));
        const addBtn = btn("add", "Add entry (Ctrl+I)", () => this.addEntry(CipherType.Login));
        addBtn.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            showMenu(this.newEntryItems(), e.clientX, e.clientY);
        });
        const addMore = h("button", { type: "button", class: "tb-btn tb-drop", title: "Add other item type", onclick: (e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(this.newEntryItems(), r.left, r.bottom);
        } }, "▾");
        this.searchInput = h("input", { type: "search", class: "search", placeholder: "Search… (Ctrl+F)", spellcheck: "false", "aria-label": "Search" });
        let timer;
        this.searchInput.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(() => this.setSearch(this.searchInput.value), 150);
        });
        this.searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                this.clearSearch();
                this.table.el.focus();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                if (this.table.rows.length) {
                    this.table.selectIndex(0, false, false);
                    this.table.el.focus();
                }
            }
        });
        return h(
            "div",
            { class: "toolbar", role: "toolbar" },
            btn("import", "Import KeePass database", () => importKeePassDialog(this)),
            btn("sync", "Synchronize (F5)", () => this.sync()),
            btn("lock", "Lock (Ctrl+L)", () => this.lock()),
            h("span", { class: "tb-sep" }),
            addBtn,
            addMore,
            btn("edit", "Edit entry (Enter)", () => this.editEntry()),
            btn("del", "Delete entry (Del)", () => this.deleteEntries()),
            h("span", { class: "tb-sep" }),
            btn("copyUser", "Copy user name (Ctrl+B)", () => this.copyField("username")),
            btn("copyPass", "Copy password (Ctrl+C)", () => this.copyField("password")),
            btn("clock", "Copy TOTP code (Ctrl+T)", () => this.copyField("totp")),
            btn("link", "Open URL (Ctrl+U)", () => this.openUrl()),
            h("span", { class: "tb-sep" }),
            btn("key", "Password generator (Ctrl+G)", () => generatorDialog()),
            h("span", { class: "tb-spacer" }),
            h("label", { class: "search-box" }, icon("search"), this.searchInput),
        );
    }

    newEntryItems() {
        return [
            { label: "Login", icon: "login", action: () => this.addEntry(CipherType.Login), shortcut: "Ctrl+I" },
            { label: "Secure note", icon: "note", action: () => this.addEntry(CipherType.SecureNote) },
            { label: "Card", icon: "card", action: () => this.addEntry(CipherType.Card) },
            { label: "Identity", icon: "identity", action: () => this.addEntry(CipherType.Identity) },
        ];
    }

    fileMenuItems() {
        return [
            { label: "Import KeePass database…", icon: "import", action: () => importKeePassDialog(this) },
            "-",
            { label: "Synchronize", icon: "sync", shortcut: "F5", action: () => this.sync() },
            this.config.webVaultEnabled ? { label: "Open Bitwarden web vault", action: () => window.open(`${BASE_URL}/#/vault`, "_blank", "noopener") } : null,
            "-",
            { label: "Lock", icon: "lock", shortcut: "Ctrl+L", action: () => this.lock() },
            { label: "Log out", action: () => this.logout(true) },
        ];
    }

    get selected() {
        return this.table ? this.table.selectedViews() : [];
    }

    get single() {
        const s = this.selected;
        return s.length === 1 ? s[0] : null;
    }

    entryMenuItems(fromMenubar = false) {
        const sel = this.selected;
        const one = this.single;
        const inTrash = sel.length > 0 && sel.every((v) => v.deletedDate);
        const anyPersonal = sel.some((v) => !v.organizationId && !v.deletedDate);
        const orgIds = new Set(sel.map((v) => v.organizationId).filter(Boolean));
        const items = [];
        if (fromMenubar) {
            items.push({ label: "Add entry", icon: "add", submenu: this.newEntryItems() }, "-");
        }
        if (one && !inTrash) {
            const fieldItems = [];
            if (one.login?.username) fieldItems.push({ label: "User name", action: () => this.copyField("username") });
            if (one.login?.password) fieldItems.push({ label: "Password", action: () => this.copyField("password") });
            if (one.login?.totp) fieldItems.push({ label: "TOTP code", action: () => this.copyField("totp") });
            for (const u of one.login?.uris || []) fieldItems.push({ label: `URL: ${u.uri}`, action: () => copyText(u.uri, "URL") });
            for (const f of one.fields) {
                if (f.type === FieldType.Linked) continue;
                fieldItems.push({ label: f.type === FieldType.Hidden ? `${f.name} (protected)` : f.name, action: () => this.copyCustomField(one, f) });
            }
            for (const [k, label] of Object.entries(one.typeData || {})) {
                if (typeof label === "string" && label && k !== "type") fieldItems.push({ label: k, action: () => this.copyTypeField(one, k) });
            }
            items.push(
                { label: "Copy user name", icon: "copyUser", shortcut: "Ctrl+B", action: () => this.copyField("username"), disabled: !one.login?.username },
                { label: "Copy password", icon: "copyPass", shortcut: "Ctrl+C", action: () => this.copyField("password"), disabled: !one.login?.password || !one.viewPassword },
                { label: "Copy TOTP code", icon: "clock", shortcut: "Ctrl+T", action: () => this.copyField("totp"), disabled: !one.login?.totp || !one.viewPassword },
                { label: "Copy field", icon: "copy", submenu: fieldItems.length ? fieldItems : [{ label: "(no fields)", disabled: true }] },
                { label: "Open URL", icon: "link", shortcut: "Ctrl+U", action: () => this.openUrl(), disabled: !one.login?.uris?.length },
                "-",
            );
        }
        if (inTrash) {
            items.push(
                { label: "Restore", icon: "sync", action: () => this.restoreEntries(), disabled: !sel.length },
                { label: "Delete permanently", icon: "del", shortcut: "Del", action: () => this.deleteEntries(), disabled: !sel.length },
            );
        } else {
            items.push(
                { label: one && one.edit !== false ? "Edit entry…" : "View entry…", icon: "edit", shortcut: "Enter", action: () => this.editEntry(), disabled: !one },
                { label: "Duplicate entry", shortcut: "Ctrl+K", action: () => this.duplicateEntry(), disabled: !one || one.decryptError },
                { label: "Delete entry", icon: "del", shortcut: "Del", action: () => this.deleteEntries(), disabled: !sel.length },
                "-",
                { label: one?.favorite ? "Remove from favorites" : "Add to favorites", icon: "star", action: () => this.toggleFavorite(), disabled: !sel.length },
                { label: "Move to folder…", icon: "folder", action: () => this.moveToFolderDialog(), disabled: !sel.length },
                { label: "Move to organization…", icon: "org", action: () => this.shareEntries(), disabled: !anyPersonal || !this.vault.organizations.size },
                { label: "Collections…", icon: "collection", action: () => this.editCollections(), disabled: orgIds.size !== 1 || sel.some((v) => !v.organizationId) },
            );
        }
        if (fromMenubar) {
            items.push("-", { label: "Select all", shortcut: "Ctrl+A", action: () => this.table.selectAll() }, { label: "Find…", icon: "search", shortcut: "Ctrl+F", action: () => this.focusSearch() });
        }
        return items;
    }

    groupMenuItems(node) {
        if (!node) return [{ label: "(no group selected)", disabled: true }];
        const isFolder = node.kind === "folder" || node.kind === "vault";
        const isCollection = node.kind === "collection" || node.kind === "org";
        const items = [];
        if (isFolder) {
            items.push(
                { label: "Add sub folder…", icon: "add", shortcut: "Insert", action: () => this.addGroup(node) },
                { label: "Rename folder…", icon: "edit", shortcut: "F2", action: () => this.renameGroup(node), disabled: node.kind !== "folder" },
                { label: "Move folder to…", icon: "folder", action: () => this.moveGroupDialog(node), disabled: node.kind !== "folder" },
                { label: "Delete folder…", icon: "del", shortcut: "Del", action: () => this.deleteGroup(node), disabled: node.kind !== "folder" },
                "-",
                { label: "Add entry here", icon: "login", action: () => this.addEntry(CipherType.Login) },
            );
        } else if (isCollection) {
            items.push(
                { label: "Add sub collection…", icon: "add", shortcut: "Insert", action: () => this.addGroup(node) },
                { label: "Rename collection…", icon: "edit", shortcut: "F2", action: () => this.renameGroup(node), disabled: node.kind !== "collection" || node.virtual },
                { label: "Delete collection…", icon: "del", shortcut: "Del", action: () => this.deleteGroup(node), disabled: node.kind !== "collection" },
                "-",
                { label: "Collection access…", icon: "user", action: () => this.collectionAccess(node.collectionIds[0]), disabled: node.kind !== "collection" || !node.collectionIds?.length || !this.vault.canManageOrg(node.orgId) },
                { label: "Manage organization…", icon: "org", action: () => this.manageOrganization(node.orgId), disabled: !this.vault.canManageOrg(node.orgId) },
                this.config.webVaultEnabled ? { label: "Open in the Bitwarden web vault", action: () => window.open(`${BASE_URL}/#/organizations/${node.orgId}/members`, "_blank", "noopener") } : null,
            );
        } else if (node.kind === "trash") {
            items.push(
                { label: "Restore all", icon: "sync", action: () => this.restoreEntries(ciphersForNode(this.vault, node)) },
                { label: "Empty trash…", icon: "trash", action: () => this.emptyTrash() },
            );
        }
        items.push("-", { label: "Expand all", action: () => this.tree.expandAll(true) }, { label: "Collapse all", action: () => this.tree.expandAll(false) });
        if (isFolder) {
            items.push(
                "-",
                { label: "Merge duplicate folders", action: () => this.folderMaintenance("merge") },
                { label: "Delete empty folders…", action: () => this.folderMaintenance("empty") },
                { label: "Create missing parent folders", action: () => this.folderMaintenance("repair") },
            );
        }
        return items;
    }

    columnMenuItems() {
        return Object.entries(COLUMNS).map(([key, col]) => ({
            label: col.title,
            checked: settings.columns.includes(key),
            action: () => {
                const cols = settings.columns.includes(key) ? settings.columns.filter((c) => c !== key) : [...settings.columns, key];
                settings.columns = cols.length ? cols : ["name"];
                this.refreshEntries();
            },
        }));
    }

    viewMenuItems() {
        return [
            { label: "Columns", submenu: this.columnMenuItems() },
            { label: "Show entries of sub folders", checked: settings.showSubfolderEntries, action: () => {
                settings.showSubfolderEntries = !settings.showSubfolderEntries;
                this.refreshEntries();
            } },
            { label: "Show entry details", checked: settings.showDetails, action: () => {
                settings.showDetails = !settings.showDetails;
                this.applyDetailsVisibility();
                this.table.renderRows(true);
            } },
            "-",
            { label: "Theme", submenu: [["auto", "Follow system"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => ({ label: l, checked: settings.theme === v, action: () => {
                settings.theme = v;
                applyTheme();
            } })) },
            "-",
            { label: "Expand all folders", action: () => this.tree.expandAll(true) },
            { label: "Collapse all folders", action: () => this.tree.expandAll(false) },
        ];
    }

    toolsMenuItems() {
        return [
            { label: "Password generator…", icon: "key", shortcut: "Ctrl+G", action: () => generatorDialog() },
            { label: "Find duplicate entries", action: () => this.findDuplicates() },
            "-",
            { label: "Merge duplicate folders", action: () => this.folderMaintenance("merge") },
            { label: "Delete empty folders…", action: () => this.folderMaintenance("empty") },
            { label: "Create missing parent folders", action: () => this.folderMaintenance("repair") },
            { label: "Empty trash…", icon: "trash", action: () => this.emptyTrash() },
            "-",
            { label: "Options…", action: async () => {
                if (await settingsDialog()) applyTheme();
            } },
        ];
    }

    helpMenuItems() {
        return [
            { label: "Keyboard shortcuts", action: () => shortcutsDialog() },
            { label: "About", action: () => alertDialog("About Vaultwarden Manager", h("div", null,
                h("p", null, "A compact vault manager for Vaultwarden, inspired by KeePass 2."),
                h("p", null, "Everything is encrypted and decrypted in this browser with the same keys and formats as the official Bitwarden apps, so all changes are immediately available in the Bitwarden browser extension, desktop, mobile apps and CLI."),
                h("p", { class: "muted" }, `Server: ${BASE_URL}`),
            )) },
        ];
    }

    // ----- Keyboard -----------------------------------------------------------------------------

    onGlobalKey(e) {
        if (!this.table || !this.vault.userKey || isDialogOpen()) return;
        if (document.querySelector(".menu")) return;
        const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
        const ctrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        const run = (fn) => {
            e.preventDefault();
            fn();
        };
        if (ctrl && key === "f") return run(() => this.focusSearch());
        if (e.key === "F3") return run(() => this.focusSearch());
        if (e.key === "F5") return run(() => this.sync());
        if (ctrl && key === "l") return run(() => this.lock());
        if (ctrl && key === "g") return run(() => generatorDialog());
        if (inInput) return;
        if (ctrl && key === "c" && !window.getSelection()?.toString()) return run(() => this.copyField("password"));
        if (ctrl && key === "b") return run(() => this.copyField("username"));
        if (ctrl && key === "t") return run(() => this.copyField("totp"));
        if (ctrl && e.shiftKey && key === "u") return run(() => this.copyField("uri"));
        if (ctrl && key === "u") return run(() => this.openUrl());
        if (ctrl && key === "e") return run(() => this.editEntry());
        if (ctrl && key === "i") return run(() => this.addEntry(CipherType.Login));
        if (ctrl && key === "k") return run(() => this.duplicateEntry());
        if (ctrl && key === "a" && document.activeElement !== this.tree.el) return run(() => this.table.selectAll());
        if (e.key === "Insert" && document.activeElement !== this.tree.el) return run(() => this.addEntry(CipherType.Login));
        if (e.key === "Delete" && document.activeElement !== this.tree.el && this.selected.length) return run(() => this.deleteEntries());
    }

    focusSearch() {
        this.searchInput.focus();
        this.searchInput.select();
    }

    setSearch(text) {
        this.searchText = text.trim();
        this.duplicateFilter = null;
        this.refreshEntries(false);
    }

    clearSearch(refresh = true) {
        this.searchInput.value = "";
        this.searchText = "";
        this.duplicateFilter = null;
        if (refresh) this.refreshEntries(false);
    }

    // ----- Details pane -----------------------------------------------------------------------------

    onSelectionChanged(views) {
        this.renderDetails(views);
        this.updateStatus();
    }

    renderDetails(views) {
        const el = this.detailsEl;
        if (!el) return;
        clear(el);
        this.detailsTotp = null;
        if (!views || !views.length) {
            el.appendChild(h("div", { class: "muted details-empty" }, "Select an entry to see its details. Double-click a user name or password to copy it."));
            return;
        }
        if (views.length > 1) {
            el.appendChild(h("div", { class: "details-title" }, `${views.length} entries selected`));
            el.appendChild(h("div", { class: "muted" }, "Drag them onto a folder to move them, or use the context menu."));
            return;
        }
        const v = views[0];
        const grid = h("div", { class: "details-grid" });
        const add = (label, value, opts = {}) => {
            if (!value && !opts.always) return;
            const val = h("span", { class: `dv${opts.mono ? " mono" : ""}${opts.pre ? " pre" : ""}` });
            if (opts.secret) {
                let shown = false;
                const masked = "••••••••";
                val.textContent = masked;
                const toggle = h("button", { type: "button", class: "icon-btn tiny", title: "Show / hide", onclick: async () => {
                    if (!shown && !(await this.reprompt(v))) return;
                    shown = !shown;
                    val.textContent = shown ? value : masked;
                } }, icon("eye"));
                grid.append(h("span", { class: "dl" }, label), h("span", { class: "dvw" }, val, toggle, this.copyButton(() => this.copySecret(v, value, label))));
                return;
            }
            if (opts.link) {
                const url = safeUrl(value);
                val.appendChild(url ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, value) : document.createTextNode(value));
            } else {
                val.textContent = value;
            }
            grid.append(h("span", { class: "dl" }, label), h("span", { class: "dvw" }, val, opts.noCopy ? "" : this.copyButton(() => copyText(value, label))));
        };
        el.appendChild(h("div", { class: "details-title" }, icon(typeIcon(v)), h("span", null, v.name || "(no title)"), v.favorite ? icon("star") : "", h("span", { class: "muted" }, this.groupName(v) ? `  —  ${this.groupName(v)}` : "")));
        if (v.decryptError) el.appendChild(h("div", { class: "form-error" }, "Parts of this item could not be decrypted."));
        if (v.login) {
            add("User name", v.login.username);
            if (v.login.password) {
                if (v.viewPassword) add("Password", v.login.password, { secret: true, mono: true });
                else add("Password", "(hidden by your organization)", { noCopy: true });
            }
            for (const u of v.login.uris) add("URL", u.uri, { link: true });
        }
        // Items with the master password re-prompt only show the basics until the password was confirmed
        if (v.reprompt === 1 && !this.repromptPassed.has(v.id)) {
            const show = h("button", { type: "button", onclick: async () => {
                if (await this.reprompt(v)) this.renderDetails([v]);
            } }, "Show all details…");
            grid.append(h("span", { class: "dl" }, ""), h("span", { class: "dvw" }, show));
            el.appendChild(grid);
            return;
        }
        if (v.login) {
            if (v.login.totp && v.viewPassword) {
                const totpEl = h("span", { class: "dv mono totp" }, "…");
                grid.append(h("span", { class: "dl" }, "TOTP"), h("span", { class: "dvw" }, totpEl, this.copyButton(() => this.copyField("totp"))));
                this.detailsTotp = { el: totpEl, view: v };
                this.renderDetailsTotp();
            }
            if (v.login.fido2Credentials?.length) add("Passkey", "Yes", { noCopy: true });
        }
        if (v.typeData && v.type !== CipherType.SecureNote) {
            for (const [k, val] of Object.entries(v.typeData)) {
                if (typeof val !== "string" || !val) continue;
                const sensitive = SENSITIVE_TYPE_FIELDS.includes(k);
                const label = k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
                if (sensitive && !v.viewPassword) add(label, "(hidden by your organization)", { noCopy: true });
                else add(label, val, { secret: sensitive, mono: sensitive });
            }
        }
        for (const f of v.fields) {
            if (f.type === FieldType.Hidden) {
                if (v.viewPassword) add(f.name, f.value, { secret: true, mono: true });
            } else if (f.type === FieldType.Boolean) add(f.name, f.value === "true" ? "☑ Yes" : "☐ No", { noCopy: true });
            else if (f.type === FieldType.Linked) add(f.name, `→ ${f.linkedId === 101 ? "Password" : "User name"}`, { noCopy: true });
            else add(f.name, f.value);
        }
        if (v.notes) add("Notes", v.notes, { pre: true });
        if (v.attachments.length) {
            const list = h("span", { class: "dvw att-links" });
            for (const a of v.attachments) {
                list.appendChild(h("a", { href: "#", onclick: (e) => {
                    e.preventDefault();
                    this.downloadAttachment(v.id, a.id);
                } }, `${a.fileName} (${formatBytes(a.size)})`));
            }
            grid.append(h("span", { class: "dl" }, "Attachments"), list);
        }
        add("Modified", formatDate(v.revisionDate), { noCopy: true });
        add("Created", formatDate(v.creationDate), { noCopy: true });
        if (v.deletedDate) add("Deleted", formatDate(v.deletedDate), { noCopy: true });
        el.appendChild(grid);
    }

    copyButton(fn) {
        return h("button", { type: "button", class: "icon-btn tiny", title: "Copy", onclick: fn }, icon("copy"));
    }

    async renderDetailsTotp() {
        const t = this.detailsTotp;
        if (!t || !document.body.contains(t.el)) return;
        try {
            const r = await totpCode(t.view.login.totp);
            t.el.textContent = r ? `${r.code.replace(/^(\d{3})(\d+)$/, "$1 $2")}   ${r.remaining}s` : "";
        } catch {
            t.el.textContent = "invalid TOTP key";
        }
    }

    // ----- Entry actions ----------------------------------------------------------------------------

    async reprompt(view) {
        if (!view || view.reprompt !== 1 || this.repromptPassed.has(view.id)) return true;
        const pw = await dialog({
            title: "Master password re-prompt",
            build: (close) => {
                const input = h("input", { type: "password", class: "wide", autocomplete: "current-password" });
                const err = h("div", { class: "form-error" });
                const ok = async () => {
                    if (await this.verifyMasterPassword(input.value)) close(true);
                    else err.textContent = "Invalid master password";
                };
                return {
                    body: h("div", { class: "form" }, h("p", null, "This item is protected, confirm your master password to continue."), input, err),
                    buttons: [h("button", { type: "button", class: "primary", onclick: ok }, "OK"), h("button", { type: "button", onclick: () => close(false) }, "Cancel")],
                    onEnter: ok,
                    initialFocus: input,
                };
            },
        });
        if (pw) this.repromptPassed.add(view.id);
        return !!pw;
    }

    async copySecret(view, value, label) {
        if (!(await this.reprompt(view))) return;
        copyText(value, label);
    }

    async copyField(which) {
        const v = this.single;
        if (!v) return;
        if (which === "username") return copyText(v.login?.username, "User name");
        if (which === "uri") return copyText(v.login?.uris?.[0]?.uri, "URL");
        if (!v.viewPassword) return toast("Your organization hides this password", "warn");
        if (which === "password") return this.copySecret(v, v.login?.password, "Password");
        if (which === "totp") {
            if (!v.login?.totp) return toast("This entry has no TOTP", "warn");
            if (!(await this.reprompt(v))) return;
            try {
                const r = await totpCode(v.login.totp);
                copyText(r.code, "TOTP code");
            } catch {
                toast("Invalid TOTP key", "error");
            }
        }
    }

    async copyCustomField(v, f) {
        if (f.type === FieldType.Hidden) {
            if (!v.viewPassword) return toast("Your organization hides this field", "warn");
            return this.copySecret(v, f.value, f.name);
        }
        copyText(f.value, f.name);
    }

    copyTypeField(v, key) {
        const sensitive = SENSITIVE_TYPE_FIELDS.includes(key);
        if (sensitive && !v.viewPassword) return toast("Your organization hides this field", "warn");
        if (sensitive) return this.copySecret(v, v.typeData[key], key);
        copyText(v.typeData[key], key);
    }

    openUrl() {
        const v = this.single;
        const url = safeUrl(v?.login?.uris?.[0]?.uri);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else toast("This entry has no URL that can be opened", "warn");
    }

    onCellDblClick(v, col) {
        if (v.deletedDate) return this.editEntry(v);
        if (col === "username" && v.login) return copyText(v.login.username, "User name");
        if (col === "password" && v.login) return this.copyField("password");
        if (col === "uri" && v.login?.uris?.length) return this.openUrl();
        this.editEntry(v);
    }

    currentFolderId() {
        const node = this.tree.selected;
        if (node?.kind === "folder" && !node.virtual) return node.folderIds[0];
        return null;
    }

    async addEntry(type) {
        const node = this.tree.selected;
        const view = newCipherView(type, null);
        if (node?.kind === "folder") view.folderId = node.virtual ? await this.vault.ensureFolderPath(node.path) : node.folderIds[0];
        if ((node?.kind === "collection" || node?.kind === "org") && this.vault.orgKeys.has(node.orgId)) {
            view.organizationId = node.orgId;
            view.collectionIds = node.collectionIds ? [...node.collectionIds] : [];
        }
        const saved = await editEntryDialog(this, view, { isNew: true });
        if (saved) {
            this.refresh();
            this.table.selectIds([saved.id]);
            toast("Entry added", "ok");
        }
    }

    async editEntry(v = this.single) {
        if (!v) return;
        if (!(await this.reprompt(v))) return;
        const saved = await editEntryDialog(this, v, { readOnly: !!v.deletedDate });
        if (saved) {
            this.refresh();
            this.table.selectIds([saved.id]);
        }
    }

    async duplicateEntry() {
        const v = this.single;
        if (!v || v.decryptError || v.deletedDate) return;
        const copy = cloneView(v);
        Object.assign(copy, { id: null, raw: null, key: null, hasCipherKey: false, name: `${v.name} - Copy`, attachments: [], passwordHistory: [] });
        if (copy.login) copy.login.fido2Credentials = null;
        try {
            const saved = await this.vault.saveCipher(copy, { collectionIds: v.collectionIds });
            this.refresh();
            this.table.selectIds([saved.id]);
            toast("Entry duplicated (without attachments)", "ok");
        } catch (e) {
            alertDialog("Duplicate failed", e.message);
        }
    }

    async deleteEntries(list = this.selected) {
        if (!list.length) return;
        const trashItems = list.filter((v) => v.deletedDate);
        const activeItems = list.filter((v) => !v.deletedDate);
        try {
            if (activeItems.length) {
                if (activeItems.some((v) => v.edit === false)) return alertDialog("Delete", "You do not have permission to delete some of the selected items.");
                const msg = activeItems.length === 1 ? `Move "${activeItems[0].name}" to the trash?` : `Move ${activeItems.length} entries to the trash?`;
                if (!(await confirmDialog("Delete entries", msg, { ok: "Move to trash", danger: true }))) return;
                await this.vault.trashCiphers(activeItems.map((v) => v.id));
                toast(`${activeItems.length} entr${activeItems.length === 1 ? "y" : "ies"} moved to the trash`, "ok");
            }
            if (trashItems.length) {
                const msg = `Permanently delete ${trashItems.length} entr${trashItems.length === 1 ? "y" : "ies"}? This can not be undone.`;
                if (!(await confirmDialog("Delete permanently", msg, { ok: "Delete permanently", danger: true }))) return;
                await this.vault.deleteCiphersPermanently(trashItems.map((v) => v.id));
                toast("Deleted permanently", "ok");
            }
        } catch (e) {
            alertDialog("Delete failed", e.message);
        }
        this.refresh();
    }

    async restoreEntries(list = this.selected) {
        const ids = list.filter((v) => v.deletedDate).map((v) => v.id);
        if (!ids.length) return;
        try {
            await this.vault.restoreCiphers(ids);
            toast(`${ids.length} entr${ids.length === 1 ? "y" : "ies"} restored`, "ok");
        } catch (e) {
            alertDialog("Restore failed", e.message);
        }
        this.refresh();
    }

    async emptyTrash() {
        const ids = [...this.vault.ciphers.values()].filter((c) => c.deletedDate && c.edit !== false).map((c) => c.id);
        if (!ids.length) return toast("The trash is empty", "info");
        if (!(await confirmDialog("Empty trash", `Permanently delete ${ids.length} entries from the trash? This can not be undone.`, { ok: "Empty trash", danger: true }))) return;
        await this.withProgress("Emptying trash", () => this.vault.deleteCiphersPermanently(ids));
    }

    async toggleFavorite() {
        const sel = this.selected.filter((v) => !v.deletedDate);
        if (!sel.length) return;
        const fav = !sel[0].favorite;
        try {
            for (const v of sel) await this.vault.setFavorite(v.id, fav);
        } catch (e) {
            alertDialog("Favorite", e.message);
        }
        this.refresh();
    }

    async moveToFolderDialog() {
        const sel = this.selected;
        if (!sel.length) return;
        const target = await this.chooseFolder("Move to folder", `Move ${sel.length} entr${sel.length === 1 ? "y" : "ies"} to:`);
        if (target === undefined) return;
        await this.moveEntriesToPath(sel.map((v) => v.id), target);
    }

    // Folder picker, returns a folder path ("" = no folder) or undefined
    chooseFolder(title, label, { exclude } = {}) {
        return dialog({
            title,
            width: "480px",
            build: (close) => {
                const paths = [...new Set([...this.vault.folders.values()].map((f) => f.path))]
                    .filter((p) => !exclude || !isSameOrDescendant(p, exclude))
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                const filter = h("input", { type: "search", class: "wide", placeholder: "Filter folders…" });
                const list = h("select", { class: "wide folder-picker", size: 14 });
                const render = () => {
                    clear(list);
                    const q = filter.value.toLowerCase();
                    list.appendChild(h("option", { value: "" }, "(No folder) — My vault"));
                    for (const p of paths) {
                        if (q && !p.toLowerCase().includes(q)) continue;
                        const depth = p.split("/").length - 1;
                        list.appendChild(h("option", { value: p }, `${"   ".repeat(depth)}${leafName(p)}`));
                    }
                    list.selectedIndex = 0;
                };
                filter.addEventListener("input", render);
                render();
                list.addEventListener("dblclick", () => close(list.value));
                return {
                    body: h("div", { class: "form" }, h("p", null, label), filter, list),
                    buttons: [h("button", { type: "button", class: "primary", onclick: () => close(list.value) }, "OK"), h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                    onEnter: () => close(list.value),
                    initialFocus: filter,
                };
            },
        });
    }

    async moveEntriesToPath(ids, path) {
        try {
            const folderId = path ? await this.vault.ensureFolderPath(path) : null;
            await this.vault.moveCiphers(ids, folderId);
            toast(`${ids.length} entr${ids.length === 1 ? "y" : "ies"} moved`, "ok");
        } catch (e) {
            alertDialog("Move failed", e.message);
        }
        this.refresh();
    }

    async shareEntries(list = this.selected, orgId, collectionIds) {
        const personal = list.filter((v) => !v.organizationId && !v.deletedDate);
        if (!personal.length) return;
        if (personal.some((v) => v.decryptError)) return alertDialog("Move to organization", "Some items can not be fully decrypted and can not be moved.");
        const choice = await shareDialog(this.vault, personal.length, orgId, collectionIds);
        if (!choice) return;
        const ok = await this.withProgress("Moving to organization", async (p) => {
            await this.vault.shareCiphers(personal.map((v) => v.id), choice.organizationId, choice.collectionIds, p);
            return true;
        });
        if (ok) toast(`${personal.length} entr${personal.length === 1 ? "y" : "ies"} moved to the organization`, "ok");
    }

    async editCollections(list = this.selected) {
        const orgIds = new Set(list.map((v) => v.organizationId));
        if (orgIds.size !== 1 || !list[0].organizationId) return;
        // The dialog shows the collections all selected items are in. Unticking one removes it from
        // all of them, ticking one adds it to all of them, everything else stays as it is.
        const common = list[0].collectionIds.filter((id) => list.every((v) => v.collectionIds.includes(id)));
        const chosen = await collectionsDialog(this.vault, list[0].organizationId, common, list.length);
        if (!chosen) return;
        const removed = common.filter((id) => !chosen.includes(id));
        const updates = list.map((v) => ({ id: v.id, ids: [...new Set([...v.collectionIds.filter((id) => !removed.includes(id)), ...chosen])] }));
        if (updates.some((u) => !u.ids.length)) {
            return alertDialog("Collections", "Every organization item needs at least one collection, otherwise only the organization admins can still see it.");
        }
        await this.withProgress("Updating collections", async () => {
            for (const u of updates) await this.vault.setCipherCollections([u.id], u.ids);
            return true;
        });
    }

    async downloadAttachment(cipherId, attachmentId) {
        const v = this.vault.ciphers.get(cipherId);
        if (!(await this.reprompt(v))) return;
        try {
            const { fileName, data } = await this.vault.downloadAttachment(cipherId, attachmentId);
            downloadBlob(data, fileName || "attachment");
        } catch (e) {
            alertDialog("Download failed", e.message);
        }
    }

    async findDuplicates() {
        const groups = new Map();
        for (const c of this.vault.ciphers.values()) {
            if (c.deletedDate || !c.login) continue;
            let host = "";
            try {
                host = new URL(safeUrl(c.login.uris[0]?.uri) || "").hostname.replace(/^www\./, "");
            } catch {
                host = "";
            }
            const key = `${(host || c.name || "").toLowerCase()}\u0000${(c.login.username || "").toLowerCase()}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(c.id);
        }
        const ids = [...groups.values()].filter((g) => g.length > 1).flat();
        if (!ids.length) return toast("No duplicate entries found", "ok");
        this.searchInput.value = "";
        this.searchText = "";
        this.duplicateFilter = ids;
        this.refreshEntries(false);
        settings.sort = { key: "uri", dir: 1 };
        this.table.setRows(this.table.rows, { keepSelection: false });
        toast(`${ids.length} entries look like duplicates (same site and user name). Press Esc in the search box to go back.`, "info", 6000);
    }

    // ----- Groups (folders & collections) -----------------------------------------------------------------

    async addGroup(node) {
        if (!node) return;
        if (node.kind === "vault" || node.kind === "folder") {
            const name = await promptDialog("Add folder", node.kind === "vault" ? "Name of the new folder:" : `New sub folder of "${node.path}":`, "", { ok: "Add" });
            if (!name || !name.trim()) return;
            const path = normalizeFolderPath(node.path ? `${node.path}/${sanitizeSegment(name)}` : sanitizeSegment(name));
            try {
                await this.vault.ensureFolderPath(path);
                this.tree.render(this.vault);
                this.tree.select(folderKey(path), true);
            } catch (e) {
                alertDialog("Add folder failed", e.message);
            }
        } else if (node.kind === "org" || node.kind === "collection") {
            const name = await promptDialog("Add collection", node.path ? `New sub collection of "${node.path}":` : "Name of the new collection:", "", { ok: "Add" });
            if (!name || !name.trim()) return;
            const path = normalizeFolderPath(node.path ? `${node.path}/${sanitizeSegment(name)}` : sanitizeSegment(name));
            try {
                // Create missing parents too, so all Bitwarden clients nest it
                const parts = path.split("/");
                for (let i = 1; i <= parts.length; i++) await this.vault.ensureCollectionPath(node.orgId, parts.slice(0, i).join("/"));
                this.tree.render(this.vault);
                this.tree.select(collectionKey(node.orgId, path), true);
            } catch (e) {
                alertDialog("Add collection failed", e.message);
            }
        }
    }

    async renameGroup(node) {
        if (!node || !node.path) return;
        const kind = node.kind === "folder" ? "folder" : "collection";
        const name = await promptDialog(`Rename ${kind}`, "New name:", node.label, { ok: "Rename" });
        if (!name || !name.trim() || name.trim() === node.label) return;
        const parent = parentPath(node.path);
        const newPath = normalizeFolderPath(parent ? `${parent}/${sanitizeSegment(name)}` : sanitizeSegment(name));
        await this.moveGroup(node, newPath);
    }

    async moveGroupDialog(node) {
        const target = await this.chooseFolder("Move folder", `Move "${node.path}" (with all sub folders and entries) into:`, { exclude: node.path });
        if (target === undefined) return;
        await this.moveGroup(node, normalizeFolderPath(target ? `${target}/${node.label}` : node.label));
    }

    async moveGroup(node, newPath) {
        if (newPath === node.path) return;
        if (node.kind === "folder") {
            // Folders which already exist at the new location are merged, ask first
            const moving = [...this.vault.folders.values()].filter((f) => isSameOrDescendant(f.path, node.path));
            const others = new Set([...this.vault.folders.values()].filter((f) => !moving.includes(f)).map((f) => f.path));
            const clashes = [...new Set(moving.map((f) => newPath + f.path.substring(node.path.length)).filter((p) => others.has(p)))];
            if (clashes.length) {
                const msg = h("div", null, h("p", null, `These folders already exist, their contents will be merged:`), h("ul", { class: "error-list" }, clashes.slice(0, 50).map((p) => h("li", null, p))));
                if (!(await confirmDialog("Merge folders", msg, { ok: "Merge" }))) return;
            }
            const ok = await this.withProgress("Moving folder", async (p) => {
                await this.vault.moveFolderPath(node.path, newPath, p);
                return true;
            });
            if (ok) this.tree.select(folderKey(newPath), false);
        } else if (node.kind === "collection") {
            const ok = await this.withProgress("Renaming collections", async () => {
                await this.moveCollection(node, newPath);
                return true;
            });
            if (ok) this.tree.select(collectionKey(node.orgId, newPath), false);
        }
        this.refresh();
    }

    async moveCollection(node, newPath) {
        const affected = [...this.vault.collections.values()].filter((c) => c.organizationId === node.orgId && isSameOrDescendant(c.path, node.path));
        const existing = new Set([...this.vault.collections.values()].filter((c) => c.organizationId === node.orgId && !affected.includes(c)).map((c) => c.path));
        for (const c of affected) {
            if (existing.has(newPath + c.path.substring(node.path.length))) throw new Error(`A collection named "${newPath + c.path.substring(node.path.length)}" already exists`);
        }
        for (const c of affected) await this.vault.renameCollection(c.id, newPath + c.path.substring(node.path.length));
    }

    async deleteGroup(node) {
        if (!node) return;
        if (node.kind === "folder") {
            const folders = [...this.vault.folders.values()].filter((f) => isSameOrDescendant(f.path, node.path));
            const ids = new Set(folders.map((f) => f.id));
            const entries = [...this.vault.ciphers.values()].filter((c) => c.folderId && ids.has(c.folderId) && !c.deletedDate);
            const choice = await dialog({
                title: "Delete folder",
                build: (close) => {
                    const trash = h("input", { type: "radio", name: "mode", checked: true });
                    const keep = h("input", { type: "radio", name: "mode" });
                    return {
                        body: h(
                            "div",
                            { class: "form" },
                            h("p", null, `Delete "${node.path}"${folders.length > 1 ? ` and its ${folders.length - 1} sub folder(s)` : ""}?`),
                            entries.length
                                ? h("div", null,
                                    h("p", null, `It contains ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:`),
                                    h("label", { class: "check" }, trash, "Move the entries to the trash (like KeePass' recycle bin)"),
                                    h("label", { class: "check" }, keep, `Keep the entries, move them to ${parentPath(node.path) ? `"${parentPath(node.path)}"` : "the top level"}`))
                                : h("p", { class: "muted" }, "The folder is empty."),
                        ),
                        buttons: [h("button", { type: "button", class: "primary danger", onclick: () => close(keep.checked ? "keep" : "trash") }, "Delete"), h("button", { type: "button", onclick: () => close(undefined) }, "Cancel")],
                    };
                },
            });
            if (!choice) return;
            await this.withProgress("Deleting folder", (p) => this.vault.deleteFolderPath(node.path, choice, p));
            this.tree.select(folderKey(parentPath(node.path)), true);
        } else if (node.kind === "collection") {
            const cols = [...this.vault.collections.values()].filter((c) => c.organizationId === node.orgId && isSameOrDescendant(c.path, node.path));
            if (!(await confirmDialog("Delete collection", `Delete the collection "${node.path}"${cols.length > 1 ? ` and its ${cols.length - 1} sub collection(s)` : ""}? The entries stay in the organization, they are only removed from these collections.`, { ok: "Delete", danger: true }))) return;
            await this.withProgress("Deleting collections", async () => {
                for (const c of cols.sort((a, b) => b.path.length - a.path.length)) await this.vault.deleteCollection(c.id);
            });
            this.tree.select(collectionKey(node.orgId, parentPath(node.path)), true);
        }
    }

    async folderMaintenance(what) {
        try {
            if (what === "merge") {
                const n = await this.withProgress("Merging folders", (p) => this.vault.mergeDuplicateFolders(p));
                if (n === undefined) return;
                toast(n ? `${n} duplicate folder(s) merged` : "No duplicate folders found", "ok");
            } else if (what === "empty") {
                const empty = this.vault.emptyFolders();
                if (!empty.length) return toast("There are no empty folders", "ok");
                const list = h("ul", { class: "error-list" }, empty.slice(0, 100).map((f) => h("li", null, f.path)));
                if (!(await confirmDialog("Delete empty folders", h("div", null, h("p", null, `Delete ${empty.length} empty folder(s)?`), list), { ok: "Delete", danger: true }))) return;
                const n = await this.withProgress("Deleting empty folders", (p) => this.vault.deleteEmptyFolders(p));
                if (n === undefined) return;
                toast(`${n} empty folder(s) deleted`, "ok");
            } else if (what === "repair") {
                const n = await this.withProgress("Creating parent folders", () => this.vault.repairFolderTree());
                if (n === undefined) return;
                toast(n ? `${n} parent folder(s) created` : "All parent folders exist", "ok");
            }
        } catch (e) {
            alertDialog("Folder maintenance", e.message);
        }
        this.refresh();
    }

    // ----- Drag & drop ----------------------------------------------------------------------------------

    canDrop(node, dt) {
        const types = [...dt.types];
        if (types.includes("application/x-vwm-entries")) {
            return ["vault", "folder", "org", "collection", "trash", "favorites"].includes(node.kind);
        }
        if (types.includes("application/x-vwm-node")) {
            const src = this._dragNode;
            if (!src) return false;
            if (src.kind === "folder") return (node.kind === "folder" || node.kind === "vault") && !isSameOrDescendant(node.path, src.path) && parentPath(src.path) !== node.path;
            if (src.kind === "collection") return (node.kind === "collection" || node.kind === "org") && node.orgId === src.orgId && !isSameOrDescendant(node.path, src.path) && parentPath(src.path) !== node.path;
        }
        return false;
    }

    async handleDrop(node, dt) {
        const entries = dt.getData("application/x-vwm-entries");
        if (entries) {
            const ids = JSON.parse(entries);
            const views = ids.map((id) => this.vault.ciphers.get(id)).filter(Boolean);
            if (node.kind === "vault" || node.kind === "folder") return this.moveEntriesToPath(ids, node.path);
            if (node.kind === "trash") return this.deleteEntries(views.filter((v) => !v.deletedDate));
            if (node.kind === "favorites") {
                for (const v of views) if (!v.favorite) await this.vault.setFavorite(v.id, true).catch((e) => toast(e.message, "error"));
                return this.refresh();
            }
            if (node.kind === "org" || node.kind === "collection") {
                const personal = views.filter((v) => !v.organizationId);
                const sameOrg = views.filter((v) => v.organizationId === node.orgId);
                const otherOrg = views.filter((v) => v.organizationId && v.organizationId !== node.orgId);
                if (otherOrg.length) toast("Items can not be moved between organizations", "warn");
                if (personal.length) await this.shareEntries(personal, node.orgId, node.collectionIds || []);
                if (sameOrg.length && node.kind === "collection") {
                    if (node.virtual) return toast("Create this collection first", "warn");
                    const ok = await confirmDialog("Move to collection", `Move ${sameOrg.length} entr${sameOrg.length === 1 ? "y" : "ies"} to the collection "${node.path}"? They are removed from their current collections.`, { ok: "Move" });
                    if (ok) await this.withProgress("Updating collections", () => this.vault.setCipherCollections(sameOrg.map((v) => v.id), node.collectionIds));
                }
                return this.refresh();
            }
            return;
        }
        const src = this._dragNode;
        this._dragNode = null;
        if (!src) return;
        const newPath = normalizeFolderPath(node.path ? `${node.path}/${src.label}` : src.label);
        if (!(await confirmDialog("Move", `Move "${src.path}" into ${node.path ? `"${node.path}"` : "the top level"}?`, { ok: "Move" }))) return;
        await this.moveGroup(src, newPath);
    }

    // ----- Sync & progress -------------------------------------------------------------------------------

    // A silent sync is a background refresh: it is skipped while anything else runs and its result
    // is dropped when the vault was changed here in the meantime. Returns true when the data was loaded.
    async sync(silent = false) {
        if (silent ? this.busy : this._syncing) return false;
        this._syncing = true;
        const selection = [...(this.table?.selection || [])];
        const prog = silent ? null : progressDialog("Synchronizing");
        const revision = this.api.get("/api/accounts/revision-date").catch(() => null);
        this.beginBusy();
        let applied = false;
        try {
            applied = await this.vault.sync((d, t) => prog?.update("Decrypting", d, t), { background: silent });
            if (applied) this.lastRevision = await revision;
            if (!silent) toast("Vault synchronized", "ok", 1500);
        } catch (e) {
            if (!silent) alertDialog("Synchronization failed", e.message);
        } finally {
            this._syncing = false;
            this.endBusy();
            prog?.close();
        }
        if (applied) {
            this.refresh();
            if (selection.length) this.table.selectIds(selection.filter((id) => this.vault.ciphers.has(id)));
            if (!silent) this.checkPendingConfirmations();
        }
        return applied;
    }

    // Runs a vault operation with a progress dialog. Errors are shown to the user, the vault is
    // synchronized again and undefined is returned, so callers should return a value on success.
    async withProgress(title, fn) {
        const prog = progressDialog(title);
        this.beginBusy();
        try {
            return await fn((done, total) => prog.update(title, done, total));
        } catch (e) {
            console.error(e);
            await this.vault.sync().catch(() => {});
            prog.close();
            await alertDialog(`${title} failed`, e.message || String(e));
            return undefined;
        } finally {
            this.endBusy();
            prog.close();
            this.refresh();
        }
    }
}

// WebAuthn: the server sends the request options with base64url values, it expects them back the same way
async function webauthnAssertion(options) {
    if (!options) throw new Error("No security key challenge received");
    const publicKey = { ...options };
    publicKey.challenge = b64urlDecode(options.challenge);
    publicKey.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlDecode(c.id) }));
    if (publicKey.extensions?.appid === undefined) delete publicKey.extensions;
    const cred = await navigator.credentials.get({ publicKey });
    if (!cred) throw new Error("No security key response");
    const r = cred.response;
    return JSON.stringify({
        id: cred.id,
        rawId: b64urlEncode(new Uint8Array(cred.rawId)),
        type: cred.type,
        extensions: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
        response: {
            authenticatorData: b64urlEncode(new Uint8Array(r.authenticatorData)),
            clientDataJson: b64urlEncode(new Uint8Array(r.clientDataJSON)),
            signature: b64urlEncode(new Uint8Array(r.signature)),
            userHandle: r.userHandle ? b64urlEncode(new Uint8Array(r.userHandle)) : null,
        },
    });
}

const app = new App();
window.vwManager = app;
app.start().catch((e) => {
    console.error(e);
    document.getElementById("app").textContent = `Failed to start: ${e.message}`;
});
