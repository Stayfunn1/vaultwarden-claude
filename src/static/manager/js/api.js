// Small client for the Bitwarden compatible API of Vaultwarden.
// It only knows about HTTP and tokens, all encryption happens in vault.js / bwcrypto.js.

import { b64urlDecode, fromUtf8 } from "./bwcrypto.js";

export const CLIENT_VERSION = "2026.8.0";

export const TwoFactorType = Object.freeze({
    Authenticator: 0,
    Email: 1,
    Duo: 2,
    YubiKey: 3,
    U2f: 4,
    Remember: 5,
    OrganizationDuo: 6,
    Webauthn: 7,
    RecoveryCode: 8,
});

export class ApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

export class TwoFactorRequired extends Error {
    constructor(body) {
        super("Two-step login required");
        this.providers = (body.TwoFactorProviders || []).map((p) => parseInt(p, 10));
        this.providerData = body.TwoFactorProviders2 || {};
    }
}

function errorMessage(body, status) {
    if (!body) return `Request failed (HTTP ${status})`;
    if (typeof body === "string") return body;
    const em = body.ErrorModel || body.errorModel;
    if (em && (em.Message || em.message)) return em.Message || em.message;
    if (body.message) return body.message;
    if (body.error_description) return body.error_description;
    const ve = body.validationErrors || body.ValidationErrors;
    if (ve) {
        const first = Object.values(ve).flat()[0];
        if (first) return first;
    }
    if (body.error && typeof body.error === "string") return body.error;
    return `Request failed (HTTP ${status})`;
}

export function decodeJwt(token) {
    try {
        return JSON.parse(fromUtf8(b64urlDecode(token.split(".")[1])));
    } catch {
        return {};
    }
}

function detectDevice() {
    const ua = globalThis.navigator?.userAgent || "";
    // Bitwarden DeviceType values
    if (/Edg\//.test(ua)) return { type: 12, name: "edge" };
    if (/OPR\//.test(ua)) return { type: 11, name: "opera" };
    if (/Firefox\//.test(ua)) return { type: 10, name: "firefox" };
    if (/Chrome\//.test(ua)) return { type: 9, name: "chrome" };
    if (/Safari\//.test(ua)) return { type: 17, name: "safari" };
    return { type: 14, name: "browser" };
}

export class Api {
    // baseUrl: the Vaultwarden DOMAIN (including any sub path), without trailing slash
    constructor(baseUrl, { deviceId, storage } = {}) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.storage = storage || null;
        const dev = detectDevice();
        this.deviceType = dev.type;
        this.deviceName = dev.name;
        this.deviceId = deviceId || this._loadDeviceId();
        this.tokens = null; // { access_token, refresh_token, expires_at }
        this.onTokensChanged = null;
        this.onUnauthorized = null;
        this._refreshing = null;
    }

    _loadDeviceId() {
        try {
            let id = globalThis.localStorage?.getItem("vwm.deviceId");
            if (!id) {
                id = globalThis.crypto.randomUUID();
                globalThis.localStorage?.setItem("vwm.deviceId", id);
            }
            return id;
        } catch {
            return globalThis.crypto.randomUUID();
        }
    }

    url(path) {
        return this.baseUrl + path;
    }

    setTokens(tokens) {
        if (tokens && tokens.access_token) {
            this.tokens = {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || this.tokens?.refresh_token || null,
                expires_at: tokens.expires_at || Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
            };
        } else {
            this.tokens = null;
        }
        if (this.onTokensChanged) this.onTokensChanged(this.tokens);
    }

    get claims() {
        return this.tokens ? decodeJwt(this.tokens.access_token) : {};
    }

    clientHeaders() {
        return {
            "Device-Type": String(this.deviceType),
            "Bitwarden-Client-Name": "web",
            "Bitwarden-Client-Version": CLIENT_VERSION,
        };
    }

    async _fetch(path, init) {
        let res;
        try {
            res = await fetch(this.url(path), init);
        } catch (e) {
            throw new ApiError(`Network error: ${e.message}`, 0, null);
        }
        return res;
    }

    static async parseBody(res) {
        const text = await res.text();
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    // ----- Identity -------------------------------------------------------------------------

    async prelogin(email) {
        return this.request("POST", "/identity/accounts/prelogin", { email }, { auth: false });
    }

    async _token(form) {
        const body = new URLSearchParams({
            scope: "api offline_access",
            client_id: "web",
            deviceType: String(this.deviceType),
            deviceIdentifier: this.deviceId,
            deviceName: this.deviceName,
            ...form,
        });
        const res = await this._fetch("/identity/connect/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", ...this.clientHeaders() },
            body,
        });
        const json = await Api.parseBody(res);
        if (!res.ok) {
            if (json && (json.TwoFactorProviders || json.TwoFactorProviders2)) {
                throw new TwoFactorRequired(json);
            }
            throw new ApiError(errorMessage(json, res.status), res.status, json);
        }
        this.setTokens(json);
        return json;
    }

    loginPassword(email, masterPasswordHash, twoFactor) {
        const form = { grant_type: "password", username: email, password: masterPasswordHash };
        if (twoFactor) {
            form.twoFactorToken = twoFactor.token;
            form.twoFactorProvider = String(twoFactor.provider);
            form.twoFactorRemember = twoFactor.remember ? "1" : "0";
        }
        return this._token(form);
    }

    loginSso(code, codeVerifier, redirectUri, twoFactor) {
        const form = { grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri };
        if (twoFactor) {
            form.twoFactorToken = twoFactor.token;
            form.twoFactorProvider = String(twoFactor.provider);
            form.twoFactorRemember = twoFactor.remember ? "1" : "0";
        }
        return this._token(form);
    }

    async sendEmailLogin(data) {
        return this.request("POST", "/api/two-factor/send-email-login", data, { auth: false });
    }

    async refresh() {
        if (!this.tokens?.refresh_token) throw new ApiError("Not logged in", 401, null);
        if (!this._refreshing) {
            this._refreshing = (async () => {
                const body = new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: "web",
                    refresh_token: this.tokens.refresh_token,
                });
                const res = await this._fetch("/identity/connect/token", {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", ...this.clientHeaders() },
                    body,
                });
                const json = await Api.parseBody(res);
                if (!res.ok) {
                    // Only a rejected refresh token ends the session, not a server that is restarting
                    if (res.status === 400 || res.status === 401) {
                        this.setTokens(null);
                        if (this.onUnauthorized) this.onUnauthorized();
                    }
                    throw new ApiError(errorMessage(json, res.status), res.status, json);
                }
                this.setTokens(json);
            })().finally(() => {
                this._refreshing = null;
            });
        }
        return this._refreshing;
    }

    async accessToken() {
        if (!this.tokens) throw new ApiError("Not logged in", 401, null);
        if (Date.now() > this.tokens.expires_at - 60_000) {
            await this.refresh();
        }
        return this.tokens.access_token;
    }

    // ----- Generic request ------------------------------------------------------------------

    async request(method, path, body, { auth = true, raw = false, retry = true, headers = {} } = {}) {
        const init = { method, headers: { ...this.clientHeaders(), ...headers } };
        if (auth) init.headers.Authorization = `Bearer ${await this.accessToken()}`;
        if (body instanceof FormData) {
            init.body = body;
        } else if (body !== undefined && body !== null) {
            init.headers["Content-Type"] = "application/json; charset=utf-8";
            init.body = JSON.stringify(body);
        }
        const res = await this._fetch(path, init);
        if (res.status === 401 && auth && retry && this.tokens?.refresh_token) {
            await this.refresh();
            return this.request(method, path, body, { auth, raw, retry: false, headers });
        }
        if (raw) return res;
        const json = await Api.parseBody(res);
        if (!res.ok) {
            if (res.status === 401 && auth && this.onUnauthorized) this.onUnauthorized();
            throw new ApiError(errorMessage(json, res.status), res.status, json);
        }
        return json;
    }

    get(path) {
        return this.request("GET", path);
    }
    post(path, body) {
        return this.request("POST", path, body ?? {});
    }
    put(path, body) {
        return this.request("PUT", path, body ?? {});
    }
    del(path, body) {
        return this.request("DELETE", path, body);
    }

    // ----- Vault ----------------------------------------------------------------------------

    sync() {
        return this.get("/api/sync?excludeDomains=true");
    }

    serverConfig() {
        return this.request("GET", "/api/config", null, { auth: false });
    }

    // Folders
    createFolder(encName) {
        return this.post("/api/folders", { name: encName });
    }
    renameFolder(id, encName) {
        return this.put(`/api/folders/${id}`, { name: encName });
    }
    deleteFolder(id) {
        return this.del(`/api/folders/${id}`);
    }

    // Ciphers
    createCipher(req) {
        return this.post("/api/ciphers", req);
    }
    createOrgCipher(req, collectionIds) {
        return this.post("/api/ciphers/create", { cipher: req, collectionIds });
    }
    updateCipher(id, req) {
        return this.put(`/api/ciphers/${id}`, req);
    }
    shareCipher(id, req, collectionIds) {
        return this.put(`/api/ciphers/${id}/share`, { cipher: req, collectionIds });
    }
    updateCipherCollections(id, collectionIds) {
        return this.put(`/api/ciphers/${id}/collections_v2`, { collectionIds });
    }
    moveCiphers(ids, folderId) {
        return this.put("/api/ciphers/move", { ids, folderId: folderId || null });
    }
    softDeleteCiphers(ids) {
        return this.put("/api/ciphers/delete", { ids });
    }
    deleteCiphersPermanently(ids) {
        return this.del("/api/ciphers", { ids });
    }
    restoreCiphers(ids) {
        return this.put("/api/ciphers/restore", { ids });
    }
    importCiphers(data) {
        return this.post("/api/ciphers/import", data);
    }
    importOrgCiphers(orgId, data) {
        return this.post(`/api/ciphers/import-organization?organizationId=${encodeURIComponent(orgId)}`, data);
    }

    // Attachments
    async uploadAttachment(cipherId, encFileName, encKey, encryptedData) {
        const meta = await this.post(`/api/ciphers/${cipherId}/attachment/v2`, {
            key: encKey,
            fileName: encFileName,
            fileSize: encryptedData.byteLength,
            adminRequest: false,
        });
        const form = new FormData();
        form.append("data", new Blob([encryptedData], { type: "application/octet-stream" }), encFileName);
        try {
            await this.request("POST", `/api${meta.url}`, form);
        } catch (e) {
            // Remove the attachment record so no broken attachment stays behind
            await this.deleteAttachment(cipherId, meta.attachmentId).catch(() => {});
            throw e;
        }
        return meta;
    }
    attachmentInfo(cipherId, attachmentId) {
        return this.get(`/api/ciphers/${cipherId}/attachment/${attachmentId}`);
    }
    deleteAttachment(cipherId, attachmentId) {
        return this.del(`/api/ciphers/${cipherId}/attachment/${attachmentId}`);
    }
    async download(url) {
        const res = await fetch(url);
        if (!res.ok) throw new ApiError(`Download failed (HTTP ${res.status})`, res.status, null);
        return new Uint8Array(await res.arrayBuffer());
    }

    // Organizations
    orgCollections(orgId) {
        return this.get(`/api/organizations/${orgId}/collections/details`);
    }
    createCollection(orgId, encName) {
        return this.post(`/api/organizations/${orgId}/collections`, { name: encName, groups: [], users: [] });
    }
    collectionDetails(orgId, collectionId) {
        return this.get(`/api/organizations/${orgId}/collections/${collectionId}/details`);
    }
    updateCollection(orgId, collectionId, data) {
        return this.put(`/api/organizations/${orgId}/collections/${collectionId}`, data);
    }
    deleteCollection(orgId, collectionId) {
        return this.del(`/api/organizations/${orgId}/collections/${collectionId}`);
    }
}
