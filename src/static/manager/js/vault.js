// Decrypted vault model and all operations which need encryption.
//
// The rules followed here mirror the official Bitwarden clients, so items created or edited
// by the manager stay fully usable in the Bitwarden web vault, browser extension, desktop,
// mobile apps and CLI:
//  - every new or edited item gets its own cipher key, wrapped with the user or organization key
//  - URIs get the `uriChecksum` the clients validate for items with a cipher key
//  - changed passwords and hidden fields are added to the password history (max 5 entries)
//  - values the manager does not edit (passkeys, card or identity data, ...) are kept as-is

import {
    SymmetricKey,
    RsaPrivateKey,
    decryptBytes,
    decryptString,
    encryptString,
    encryptBytes,
    encryptFile,
    decryptFile,
    isEncString,
    uriChecksum,
    deriveMasterKey,
    hashMasterKey,
    decryptUserKey,
    CryptoError,
    generateRsaKeyPair,
    rsaEncrypt,
    b64encode,
} from "./bwcrypto.js";

export const CipherType = Object.freeze({
    Login: 1,
    SecureNote: 2,
    Card: 3,
    Identity: 4,
    SshKey: 5,
    BankAccount: 6,
    DriversLicense: 7,
    Passport: 8,
});

export const CipherTypeNames = {
    1: "Login",
    2: "Secure note",
    3: "Card",
    4: "Identity",
    5: "SSH key",
    6: "Bank account",
    7: "Driver's license",
    8: "Passport",
};

// The property holding the type specific data in the API
export const TypeDataKey = {
    1: "login",
    2: "secureNote",
    3: "card",
    4: "identity",
    5: "sshKey",
    6: "bankAccount",
    7: "driversLicense",
    8: "passport",
};

export const FieldType = Object.freeze({ Text: 0, Hidden: 1, Boolean: 2, Linked: 3 });

// Editable properties of the type specific objects (all of them are encrypted strings)
export const TypeFields = {
    3: [
        ["cardholderName", "Cardholder name"],
        ["brand", "Brand"],
        ["number", "Number", true],
        ["expMonth", "Expiration month"],
        ["expYear", "Expiration year"],
        ["code", "Security code", true],
    ],
    4: [
        ["title", "Title"],
        ["firstName", "First name"],
        ["middleName", "Middle name"],
        ["lastName", "Last name"],
        ["username", "Username"],
        ["company", "Company"],
        ["email", "Email"],
        ["phone", "Phone"],
        ["ssn", "Social security number", true],
        ["passportNumber", "Passport number", true],
        ["licenseNumber", "License number", true],
        ["address1", "Address 1"],
        ["address2", "Address 2"],
        ["address3", "Address 3"],
        ["city", "City"],
        ["state", "State / province"],
        ["postalCode", "Postal code"],
        ["country", "Country"],
    ],
    5: [
        ["privateKey", "Private key", true, true],
        ["publicKey", "Public key", false, true],
        ["keyFingerprint", "Fingerprint"],
    ],
};

const MAX_PASSWORD_HISTORY = 5;
export const FOLDER_DELIMITER = "/";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

export async function mapLimit(items, limit, fn, onProgress) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    let failed = false;
    async function worker() {
        // After the first failure no new work is started, the error is reported by Promise.all
        while (next < items.length && !failed) {
            const i = next++;
            try {
                results[i] = await fn(items[i], i);
            } catch (e) {
                failed = true;
                throw e;
            }
            done++;
            if (onProgress) onProgress(done, items.length);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export function normalizeFolderPath(name) {
    return String(name ?? "")
        .split(FOLDER_DELIMITER)
        .map((s) => s.trim())
        .filter((s) => s.length)
        .join(FOLDER_DELIMITER);
}

export function parentPath(path) {
    const i = path.lastIndexOf(FOLDER_DELIMITER);
    return i === -1 ? "" : path.substring(0, i);
}

export function leafName(path) {
    const i = path.lastIndexOf(FOLDER_DELIMITER);
    return i === -1 ? path : path.substring(i + 1);
}

export function isSameOrDescendant(path, ancestor) {
    return path === ancestor || path.startsWith(ancestor + FOLDER_DELIMITER);
}

// Folder (or collection) names can not contain the delimiter, otherwise they would nest
export function sanitizeSegment(name) {
    return String(name ?? "")
        .replace(/\//g, "∕")
        .trim();
}

// Decrypts a value which must be encrypted (or empty).
// Plain text where an encrypted value is expected is an error: it can only come from a tampered server.
async function decryptMaybe(value, key, errors) {
    if (value === null || value === undefined || value === "") return value ?? null;
    if (!isEncString(value)) {
        errors.push(new CryptoError("Unencrypted value where an encrypted one was expected"));
        return null;
    }
    try {
        return await decryptString(value, key);
    } catch (e) {
        errors.push(e);
        return null;
    }
}

// Decrypt all EncString properties of a (type specific) object and remember which ones were encrypted.
// `expected` lists properties which must be encrypted when they are set.
async function decryptObject(obj, key, errors, expected = []) {
    if (!obj || typeof obj !== "object") return { plain: obj ?? null, encryptedKeys: [] };
    const plain = {};
    const encryptedKeys = [];
    for (const [k, v] of Object.entries(obj)) {
        if (k === "response" || k === "object") continue;
        if (isEncString(v) || (expected.includes(k) && typeof v === "string" && v !== "")) {
            encryptedKeys.push(k);
            plain[k] = await decryptMaybe(v, key, errors);
        } else {
            plain[k] = v;
        }
    }
    return { plain, encryptedKeys };
}

async function encryptObject(plain, encryptedKeys, key) {
    if (!plain) return null;
    const out = {};
    for (const [k, v] of Object.entries(plain)) {
        if (encryptedKeys.includes(k) && v !== null && v !== undefined && v !== "") {
            out[k] = await encryptString(v, key);
        } else if (encryptedKeys.includes(k)) {
            out[k] = null;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------------

export class Vault {
    constructor(api) {
        this.api = api;
        this.userKey = null;
        this.privateKey = null;
        this.orgKeys = new Map();
        this.profile = null;
        this.organizations = new Map();
        this.folders = new Map(); // id -> { id, name, path }
        this.collections = new Map(); // id -> { id, organizationId, name, path, readOnly, hidePasswords, manage }
        this.ciphers = new Map(); // id -> CipherView
        this.policies = [];
        this.lastSync = null;
        this.onChange = null;
        // Running vault operations, a background sync must not mix its (older) data with their changes
        this._ops = 0;
        this._opGen = 0;
    }

    get busy() {
        return this._ops > 0;
    }

    async _op(fn) {
        this._ops++;
        this._opGen++;
        try {
            return await fn();
        } finally {
            this._ops--;
        }
    }

    get userId() {
        return this.profile?.id || this.api.claims.sub;
    }

    lock() {
        this.userKey = null;
        this.privateKey = null;
        this.orgKeys.clear();
        this.folders.clear();
        this.collections.clear();
        this.ciphers.clear();
        this.organizations.clear();
        this.profile = null;
    }

    changed(what) {
        if (this.onChange) this.onChange(what);
    }

    // ----- Unlocking ----------------------------------------------------------------------

    static async preparePasswordLogin(api, email, password) {
        const kdf = await api.prelogin(email);
        const masterKey = await deriveMasterKey(password, email, kdf);
        const hash = await hashMasterKey(masterKey, password);
        return { kdf, masterKey, hash };
    }

    // Unlock with the master password, using the KDF settings and encrypted key of the token response
    async unlock(email, password, encUserKey, kdf) {
        const masterKey = await deriveMasterKey(password, email, kdf);
        try {
            this.userKey = await decryptUserKey(encUserKey, masterKey);
        } catch (e) {
            if (e instanceof CryptoError || e?.name === "OperationError") {
                throw new CryptoError("Invalid master password");
            }
            throw e;
        }
    }

    async setUserKeyFromMasterKey(masterKey, encUserKey) {
        this.userKey = await decryptUserKey(encUserKey, masterKey);
    }

    // ----- Sync & decryption --------------------------------------------------------------

    // Loads and decrypts the whole vault. Returns false when the result was discarded:
    // a background sync is dropped when a vault operation ran in the meantime, and nothing is
    // loaded into a vault that got locked while decrypting.
    async sync(onProgress, { background = false } = {}) {
        const gen = this._opGen;
        const data = await this.api.sync();
        return this.loadSync(data, onProgress, () => background && (this._ops > 0 || this._opGen !== gen));
    }

    async loadSync(data, onProgress, discard = () => false) {
        const userKey = this.userKey;
        if (!userKey) throw new CryptoError("Vault is locked");
        const profile = data.profile;

        // Everything is decrypted into new maps first and swapped in at the end, so the vault
        // is never seen half loaded by other code running in the meantime
        let privateKey = null;
        if (profile.privateKey) {
            try {
                privateKey = new RsaPrivateKey(await decryptBytes(profile.privateKey, userKey));
            } catch (e) {
                console.error("Unable to decrypt the private key", e);
            }
        }
        const orgKeys = new Map();
        const organizations = new Map();
        for (const org of profile.organizations || []) {
            organizations.set(org.id, {
                id: org.id,
                name: org.name,
                type: org.type,
                status: org.status,
                enabled: org.enabled,
                permissions: org.permissions || {},
                usersGetPremium: org.usersGetPremium,
                useGroups: org.useGroups,
            });
            if (org.key && privateKey) {
                try {
                    orgKeys.set(org.id, new SymmetricKey(await decryptBytes(org.key, privateKey)));
                } catch (e) {
                    console.error(`Unable to decrypt the key of organization ${org.id}`, e);
                }
            }
        }
        const folders = new Map();
        for (const f of data.folders || []) await this._addFolder(f, folders, userKey);
        const collections = new Map();
        for (const c of data.collections || []) await this._addCollection(c, collections, orgKeys);
        const views = await mapLimit(data.ciphers || [], 16, (raw) => this.decryptCipher(raw, { userKey, orgKeys }), onProgress);

        if (this.userKey !== userKey || discard()) return false;
        this.profile = { id: profile.id, email: profile.email, name: profile.name, key: profile.key };
        this.policies = data.policies || [];
        this.privateKey = privateKey;
        this.orgKeys = orgKeys;
        this.organizations = organizations;
        this.folders = folders;
        this.collections = collections;
        this.ciphers = new Map(views.map((v) => [v.id, v]));
        this.lastSync = Date.now();
        this.changed("all");
        return true;
    }

    async _addFolder(raw, map = this.folders, userKey = this.userKey) {
        const errors = [];
        const name = await decryptMaybe(raw.name, userKey, errors);
        const folder = {
            id: raw.id,
            name: name ?? "[error: cannot decrypt]",
            path: normalizeFolderPath(name ?? `[error ${raw.id}]`),
            revisionDate: raw.revisionDate,
            error: errors.length > 0,
        };
        map.set(folder.id, folder);
        return folder;
    }

    async _addCollection(raw, map = this.collections, orgKeys = this.orgKeys) {
        const key = orgKeys.get(raw.organizationId);
        const errors = [];
        const name = key ? await decryptMaybe(raw.name, key, errors) : null;
        const col = {
            id: raw.id,
            organizationId: raw.organizationId,
            name: name ?? "[error: cannot decrypt]",
            path: normalizeFolderPath(name ?? `[error ${raw.id}]`),
            readOnly: !!raw.readOnly,
            hidePasswords: !!raw.hidePasswords,
            manage: !!raw.manage,
            externalId: raw.externalId,
        };
        map.set(col.id, col);
        return col;
    }

    baseKeyFor(organizationId, keys = { userKey: this.userKey, orgKeys: this.orgKeys }) {
        if (organizationId) {
            const k = keys.orgKeys.get(organizationId);
            if (!k) throw new CryptoError("Missing organization key");
            return k;
        }
        return keys.userKey;
    }

    async decryptCipher(raw, keys) {
        const errors = [];
        const view = {
            id: raw.id,
            type: raw.type,
            organizationId: raw.organizationId || null,
            folderId: raw.folderId || null,
            collectionIds: raw.collectionIds || [],
            favorite: !!raw.favorite,
            reprompt: raw.reprompt || 0,
            edit: raw.edit !== false,
            viewPassword: raw.viewPassword !== false,
            revisionDate: raw.revisionDate,
            creationDate: raw.creationDate,
            deletedDate: raw.deletedDate || null,
            archivedDate: raw.archivedDate || null,
            name: null,
            notes: null,
            login: null,
            typeData: null,
            typeEncryptedKeys: [],
            fields: [],
            passwordHistory: [],
            attachments: [],
            raw,
            key: null,
            hasCipherKey: !!raw.key,
            decryptError: false,
        };
        let key;
        try {
            const baseKey = this.baseKeyFor(view.organizationId, keys);
            key = raw.key ? new SymmetricKey(await decryptBytes(raw.key, baseKey)) : baseKey;
        } catch (e) {
            view.decryptError = true;
            view.name = "[error: cannot decrypt]";
            return view;
        }
        view.key = key;
        view.name = await decryptMaybe(raw.name, key, errors);
        view.notes = await decryptMaybe(raw.notes, key, errors);

        if (raw.type === CipherType.Login) {
            const l = raw.login || {};
            view.login = {
                username: await decryptMaybe(l.username, key, errors),
                password: await decryptMaybe(l.password, key, errors),
                totp: await decryptMaybe(l.totp, key, errors),
                passwordRevisionDate: l.passwordRevisionDate || null,
                autofillOnPageLoad: l.autofillOnPageLoad ?? null,
                uris: [],
                fido2Credentials: l.fido2Credentials || null,
            };
            for (const u of l.uris || []) {
                const uri = await decryptMaybe(u.uri, key, errors);
                if (uri === null) continue;
                // Like the official clients: for items with a cipher key, URIs without a valid checksum
                // were changed by the server and are dropped (they would be used for auto-fill)
                if (raw.key) {
                    const sum = u.uriChecksum ? await decryptMaybe(u.uriChecksum, key, errors) : null;
                    if (sum !== (await uriChecksum(uri))) continue;
                }
                view.login.uris.push({ uri, match: u.match ?? null });
            }
        } else {
            const typeKey = TypeDataKey[raw.type];
            if (typeKey && raw[typeKey]) {
                const expected = (TypeFields[raw.type] || []).map((f) => f[0]);
                const { plain, encryptedKeys } = await decryptObject(raw[typeKey], key, errors, expected);
                view.typeData = plain;
                view.typeEncryptedKeys = encryptedKeys;
            } else if (raw.type === CipherType.SshKey) {
                // The server hides SSH keys with missing parts, saving such an item would erase the key
                errors.push(new CryptoError("The SSH key data of this item is incomplete"));
            }
        }

        for (const f of raw.fields || []) {
            view.fields.push({
                name: await decryptMaybe(f.name, key, errors),
                value: await decryptMaybe(f.value, key, errors),
                type: f.type ?? FieldType.Text,
                linkedId: f.linkedId ?? null,
            });
        }
        for (const h of raw.passwordHistory || []) {
            view.passwordHistory.push({
                password: await decryptMaybe(h.password, key, errors),
                lastUsedDate: h.lastUsedDate,
            });
        }
        for (const a of raw.attachments || []) {
            let attKey = null;
            if (a.key) {
                try {
                    attKey = new SymmetricKey(await decryptBytes(a.key, key));
                } catch (e) {
                    errors.push(e);
                }
            }
            view.attachments.push({
                id: a.id,
                fileName: await decryptMaybe(a.fileName, key, errors),
                size: Number(a.size),
                sizeName: a.sizeName,
                url: a.url,
                key: attKey,
            });
        }
        if (errors.length) {
            view.decryptError = true;
            console.warn(`Cipher ${raw.id} has values which could not be decrypted`, errors);
        }
        if (view.name === null) view.name = view.decryptError ? "[error: cannot decrypt]" : "";
        return view;
    }

    // ----- Cipher encryption --------------------------------------------------------------

    // Builds the API request for a cipher view.
    // Options:
    //   organizationId: target organization (for sharing), defaults to the current one
    //   cipherKey: the cipher key to use for a new item (the importer needs it for attachments)
    async encryptCipher(view, { organizationId, cipherKey: newCipherKey } = {}) {
        const targetOrg = organizationId !== undefined ? organizationId : view.organizationId;
        const wrappingKey = this.baseKeyFor(targetOrg);
        const raw = view.raw || {};

        // Keep the existing cipher key, otherwise create one (like the official clients do)
        const keepKey = view.hasCipherKey && view.key;
        const cipherKey = keepKey ? view.key : newCipherKey || SymmetricKey.generate();
        const keyChanged = !keepKey;

        const enc = (v) => (v === null || v === undefined || v === "" ? Promise.resolve(null) : encryptString(v, cipherKey));

        const req = {
            type: view.type,
            folderId: view.folderId || null,
            organizationId: targetOrg || null,
            name: await enc(view.name || ""),
            notes: await enc(view.notes),
            favorite: !!view.favorite,
            reprompt: view.reprompt || 0,
            key: await encryptBytes(cipherKey.raw, wrappingKey),
            encryptedFor: this.userId,
            lastKnownRevisionDate: raw.revisionDate || null,
            archivedDate: view.archivedDate || null,
            fields: null,
            passwordHistory: null,
        };

        if (view.type === CipherType.Login) {
            const l = view.login || {};
            const uris = [];
            for (const u of l.uris || []) {
                if (!u.uri) continue;
                uris.push({ uri: await enc(u.uri), uriChecksum: await enc(await uriChecksum(u.uri)), match: u.match ?? null });
            }
            let fido2 = l.fido2Credentials || null;
            if (fido2 && fido2.length && keyChanged) {
                // Passkeys are encrypted with the old key, move them to the new one
                const moved = [];
                for (const cred of fido2) {
                    const errors = [];
                    const { plain, encryptedKeys } = await decryptObject(cred, view.key, errors);
                    if (errors.length) throw new CryptoError("Unable to re-encrypt the passkey of this item");
                    moved.push(await encryptObject(plain, encryptedKeys, cipherKey));
                }
                fido2 = moved;
            }
            req.login = {
                username: await enc(l.username),
                password: await enc(l.password),
                totp: await enc(l.totp),
                passwordRevisionDate: l.passwordRevisionDate || null,
                autofillOnPageLoad: l.autofillOnPageLoad ?? null,
                uris: uris.length ? uris : null,
                fido2Credentials: fido2,
            };
        } else if (view.type === CipherType.SecureNote) {
            req.secureNote = { type: view.typeData?.type ?? 0 };
        } else {
            const typeKey = TypeDataKey[view.type];
            if (typeKey) {
                const known = (TypeFields[view.type] || []).map((f) => f[0]);
                const encryptedKeys = Array.from(new Set([...(view.typeEncryptedKeys || []), ...known]));
                req[typeKey] = await encryptObject(view.typeData || {}, encryptedKeys, cipherKey);
            }
        }

        if (view.fields && view.fields.length) {
            req.fields = [];
            for (const f of view.fields) {
                req.fields.push({
                    name: await enc(f.name),
                    value: await enc(f.value),
                    type: f.type ?? FieldType.Text,
                    linkedId: f.linkedId ?? null,
                });
            }
        }
        if (view.passwordHistory && view.passwordHistory.length) {
            req.passwordHistory = [];
            for (const h of view.passwordHistory) {
                req.passwordHistory.push({ password: await enc(h.password), lastUsedDate: h.lastUsedDate });
            }
        }

        // When the cipher key changes, the attachment keys and names need to be re-encrypted
        if (keyChanged && view.attachments && view.attachments.length) {
            req.attachments2 = {};
            for (const a of view.attachments) {
                if (!a.key) throw new CryptoError("This item has a legacy attachment without key and can not be re-encrypted");
                req.attachments2[a.id] = {
                    fileName: await encryptString(a.fileName, cipherKey),
                    key: await encryptBytes(a.key.raw, cipherKey),
                };
            }
        }
        return req;
    }

    // Applies the password history rules of the Bitwarden clients
    // The history is never edited by the user, so it is always taken from the stored item: a view that
    // was saved before (e.g. a retry after a failed attachment upload) can not drop newer entries.
    static updateHistory(view, original) {
        if (!original) return view;
        const now = new Date().toISOString();
        const history = [...(original.passwordHistory || [])];
        if (view.type === CipherType.Login && original.login && view.login) {
            const oldPw = original.login.password;
            if (oldPw && oldPw !== (view.login.password ?? null)) {
                history.unshift({ password: oldPw, lastUsedDate: now });
                view.login.passwordRevisionDate = now;
            } else {
                view.login.passwordRevisionDate = original.login.passwordRevisionDate || null;
            }
        }
        const oldHidden = (original.fields || []).filter((f) => f.type === FieldType.Hidden && f.name && f.value);
        for (const of of oldHidden) {
            const nf = (view.fields || []).find((f) => f.type === FieldType.Hidden && f.name === of.name);
            if (!nf || nf.value !== of.value) {
                history.unshift({ password: `${of.name}: ${of.value}`, lastUsedDate: now });
            }
        }
        view.passwordHistory = history.slice(0, MAX_PASSWORD_HISTORY);
        return view;
    }

    async _storeCipher(raw) {
        const v = await this.decryptCipher(raw);
        this.ciphers.set(v.id, v);
        return v;
    }

    async saveCipher(view, { collectionIds } = {}) {
        if (view.id) {
            const original = this.ciphers.get(view.id);
            if (original?.decryptError) throw new CryptoError("Items which can not be fully decrypted can not be edited here");
            // The history is added to a copy, so retrying a failed save does not add it twice
            const req = await this.encryptCipher(Vault.updateHistory(cloneView(view), original));
            const raw = await this.api.updateCipher(view.id, req);
            const v = await this._storeCipher(raw);
            this.changed("cipher");
            return v;
        }
        const req = await this.encryptCipher(view);
        let raw;
        if (req.organizationId) {
            raw = await this.api.createOrgCipher(req, collectionIds || view.collectionIds || []);
        } else {
            raw = await this.api.createCipher(req);
        }
        const v = await this._storeCipher(raw);
        this.changed("cipher");
        return v;
    }

    // Move personal items into an organization (Bitwarden "Move to organization")
    async shareCiphers(ids, organizationId, collectionIds, onProgress) {
        const results = await mapLimit(
            ids,
            4,
            async (id) => {
                const view = this.ciphers.get(id);
                if (!view || view.organizationId) return null;
                const req = await this.encryptCipher(view, { organizationId });
                const raw = await this.api.shareCipher(id, req, collectionIds);
                return this._storeCipher(raw);
            },
            onProgress,
        );
        this.changed("cipher");
        return results;
    }

    async setCipherCollections(ids, collectionIds) {
        for (const id of ids) {
            const raw = await this.api.updateCipherCollections(id, collectionIds);
            const cipherRaw = raw?.cipher || raw;
            if (cipherRaw && cipherRaw.id) {
                await this._storeCipher(cipherRaw);
            } else {
                const v = this.ciphers.get(id);
                if (v) v.collectionIds = [...collectionIds];
            }
        }
        this.changed("cipher");
    }

    async moveCiphers(ids, folderId) {
        for (const part of chunk(ids, 500)) {
            await this.api.moveCiphers(part, folderId);
            for (const id of part) {
                const v = this.ciphers.get(id);
                if (v) {
                    v.folderId = folderId || null;
                    if (v.raw) v.raw.folderId = folderId || null;
                }
            }
        }
        this.changed("cipher");
    }

    async setFavorite(id, favorite) {
        const v = this.ciphers.get(id);
        if (!v) return;
        const raw = await this.api.put(`/api/ciphers/${id}/partial`, { folderId: v.folderId, favorite });
        if (raw?.id) await this._storeCipher(raw);
        else v.favorite = favorite;
        this.changed("cipher");
    }

    async trashCiphers(ids) {
        const now = new Date().toISOString();
        for (const part of chunk(ids, 500)) {
            await this.api.softDeleteCiphers(part);
            for (const id of part) {
                const v = this.ciphers.get(id);
                if (v) v.deletedDate = now;
            }
        }
        this.changed("cipher");
    }

    async restoreCiphers(ids) {
        for (const part of chunk(ids, 500)) {
            const res = await this.api.restoreCiphers(part);
            // Restoring changes the revision date, keep the returned items so they can be edited right away
            for (const raw of res?.data || []) await this._storeCipher(raw);
            for (const id of part) {
                const v = this.ciphers.get(id);
                if (v) v.deletedDate = null;
            }
        }
        this.changed("cipher");
    }

    async deleteCiphersPermanently(ids) {
        for (const part of chunk(ids, 500)) {
            await this.api.deleteCiphersPermanently(part);
            for (const id of part) this.ciphers.delete(id);
        }
        this.changed("cipher");
    }

    // ----- Attachments --------------------------------------------------------------------

    // Upload a file to an existing cipher. The cipher gets a cipher key first if it has none.
    async addAttachment(cipherId, fileName, data) {
        let view = this.ciphers.get(cipherId);
        if (!view) throw new Error("Unknown item");
        if (!view.hasCipherKey) {
            // Upgrade to a cipher key, so the attachment is protected by it like in the official clients
            view = await this.saveCipher(cloneView(view));
        }
        const attKey = SymmetricKey.generate();
        const encData = await encryptFile(data, attKey);
        const encName = await encryptString(fileName, view.key);
        const encKey = await encryptBytes(attKey.raw, view.key);
        const meta = await this.api.uploadAttachment(cipherId, encName, encKey, encData);
        // The response contains the cipher before the upload finished, so fetch it again
        const raw = await this.api.get(`/api/ciphers/${cipherId}`);
        await this._storeCipher(raw);
        this.changed("cipher");
        return meta.attachmentId;
    }

    async downloadAttachment(cipherId, attachmentId) {
        const view = this.ciphers.get(cipherId);
        const att = view?.attachments.find((a) => a.id === attachmentId);
        if (!att) throw new Error("Unknown attachment");
        const info = await this.api.attachmentInfo(cipherId, attachmentId);
        const encData = await this.api.download(info.url);
        const key = att.key || view.key;
        return { fileName: att.fileName, data: await decryptFile(encData, key) };
    }

    async deleteAttachment(cipherId, attachmentId) {
        await this.api.deleteAttachment(cipherId, attachmentId);
        const raw = await this.api.get(`/api/ciphers/${cipherId}`);
        await this._storeCipher(raw);
        this.changed("cipher");
    }

    // ----- Folders ------------------------------------------------------------------------

    foldersByPath() {
        const map = new Map();
        for (const f of this.folders.values()) {
            if (!map.has(f.path)) map.set(f.path, []);
            map.get(f.path).push(f);
        }
        return map;
    }

    folderIdForPath(path) {
        path = normalizeFolderPath(path);
        if (!path) return null;
        const list = this.foldersByPath().get(path);
        return list && list.length ? list[0].id : undefined;
    }

    async createFolder(path) {
        path = normalizeFolderPath(path);
        if (!path) throw new Error("Folder name can not be empty");
        const raw = await this.api.createFolder(await encryptString(path, this.userKey));
        const f = await this._addFolder(raw);
        this.changed("folder");
        return f;
    }

    // Returns the folder id for a path, creating it and all missing parents when needed
    async ensureFolderPath(path) {
        path = normalizeFolderPath(path);
        if (!path) return null;
        const parts = path.split(FOLDER_DELIMITER);
        let id = null;
        for (let i = 1; i <= parts.length; i++) {
            const p = parts.slice(0, i).join(FOLDER_DELIMITER);
            id = this.folderIdForPath(p);
            if (id === undefined) id = (await this.createFolder(p)).id;
        }
        return id;
    }

    async _renameFolder(folder, newPath) {
        const raw = await this.api.renameFolder(folder.id, await encryptString(newPath, this.userKey));
        await this._addFolder(raw);
    }

    ciphersInFolders(folderIds, { includeDeleted = true } = {}) {
        const set = new Set(folderIds);
        return [...this.ciphers.values()].filter((c) => c.folderId && set.has(c.folderId) && (includeDeleted || !c.deletedDate));
    }

    // Rename or move a folder including all sub folders. Existing folders at the target are merged.
    async moveFolderPath(oldPath, newPath, onProgress) {
        oldPath = normalizeFolderPath(oldPath);
        newPath = normalizeFolderPath(newPath);
        if (!oldPath || !newPath || oldPath === newPath) return;
        if (isSameOrDescendant(newPath, oldPath)) throw new Error("A folder can not be moved into itself");

        const affected = [...this.folders.values()].filter((f) => isSameOrDescendant(f.path, oldPath));
        const affectedIds = new Set(affected.map((f) => f.id));
        const byPath = this.foldersByPath();
        let done = 0;
        for (const f of affected) {
            const target = newPath + f.path.substring(oldPath.length);
            const existing = (byPath.get(target) || []).find((x) => !affectedIds.has(x.id));
            if (existing) {
                // Merge into the existing folder
                const ids = this.ciphersInFolders([f.id]).map((c) => c.id);
                if (ids.length) await this.moveCiphers(ids, existing.id);
                await this.api.deleteFolder(f.id);
                this.folders.delete(f.id);
            } else {
                await this._renameFolder(f, target);
            }
            if (onProgress) onProgress(++done, affected.length);
        }
        // Make sure the new location has all parents (Bitwarden shows "a/b" as one node when "a" is missing)
        const parent = parentPath(newPath);
        if (parent) await this.ensureFolderPath(parent);
        if (!affected.length) await this.ensureFolderPath(newPath);
        this.changed("folder");
    }

    // mode "keep": items move to the parent folder, mode "trash": items are moved to the trash
    async deleteFolderPath(path, mode = "keep", onProgress) {
        path = normalizeFolderPath(path);
        const affected = [...this.folders.values()].filter((f) => isSameOrDescendant(f.path, path));
        const ids = affected.map((f) => f.id);
        let items = this.ciphersInFolders(ids, { includeDeleted: false });
        if (mode === "trash") {
            const trash = items.filter((c) => c.edit);
            if (trash.length) await this.trashCiphers(trash.map((c) => c.id));
            items = items.filter((c) => !c.edit);
        }
        if (items.length) {
            // Everything that stays (or can not be deleted by this user) moves to the parent folder
            const parent = parentPath(path);
            const parentId = parent ? await this.ensureFolderPath(parent) : null;
            await this.moveCiphers(
                items.map((c) => c.id),
                parentId,
            );
        }
        let done = 0;
        // Delete the deepest folders first
        affected.sort((a, b) => b.path.length - a.path.length);
        for (const f of affected) {
            await this.api.deleteFolder(f.id);
            this.folders.delete(f.id);
            if (onProgress) onProgress(++done, affected.length);
        }
        // Deleting a folder on the server also removes it from the (trashed) items still in it
        const deleted = new Set(ids);
        for (const c of this.ciphers.values()) {
            if (c.folderId && deleted.has(c.folderId)) c.folderId = null;
        }
        this.changed("folder");
    }

    // Folders with the same name are merged into one
    async mergeDuplicateFolders(onProgress) {
        const groups = [...this.foldersByPath().values()].filter((l) => l.length > 1);
        let merged = 0;
        for (const list of groups) {
            const [keep, ...rest] = list;
            for (const f of rest) {
                const ids = this.ciphersInFolders([f.id]).map((c) => c.id);
                if (ids.length) await this.moveCiphers(ids, keep.id);
                await this.api.deleteFolder(f.id);
                this.folders.delete(f.id);
                merged++;
            }
            if (onProgress) onProgress(merged, groups.length);
        }
        this.changed("folder");
        return merged;
    }

    // Folders without any item in them or their sub folders
    emptyFolders() {
        const used = new Set();
        for (const c of this.ciphers.values()) {
            if (!c.folderId) continue;
            const f = this.folders.get(c.folderId);
            if (!f) continue;
            const parts = f.path.split(FOLDER_DELIMITER);
            for (let i = 1; i <= parts.length; i++) used.add(parts.slice(0, i).join(FOLDER_DELIMITER));
        }
        return [...this.folders.values()].filter((f) => !used.has(f.path));
    }

    async deleteEmptyFolders(onProgress) {
        const empty = this.emptyFolders();
        let done = 0;
        for (const f of empty) {
            await this.api.deleteFolder(f.id);
            this.folders.delete(f.id);
            if (onProgress) onProgress(++done, empty.length);
        }
        this.changed("folder");
        return empty.length;
    }

    // Create parent folders which only exist implicitly
    async repairFolderTree() {
        const paths = new Set([...this.folders.values()].map((f) => f.path));
        const missing = new Set();
        for (const p of paths) {
            let parent = parentPath(p);
            while (parent) {
                if (!paths.has(parent)) missing.add(parent);
                parent = parentPath(parent);
            }
        }
        const sorted = [...missing].sort((a, b) => a.length - b.length);
        for (const p of sorted) {
            if (this.folderIdForPath(p) === undefined) await this.createFolder(p);
        }
        this.changed("folder");
        return sorted.length;
    }

    // ----- Organizations ------------------------------------------------------------------

    // Owners, admins and members with the "manage users" permission manage the members of an organization
    canManageOrg(organizationId) {
        const org = this.organizations.get(organizationId);
        return !!org && org.status === 2 && (org.type === 0 || org.type === 1 || !!org.permissions?.manageUsers);
    }

    // Creates an organization like the Bitwarden clients: the organization key and its RSA key pair are made here,
    // the server only gets them encrypted (with the public key of this account and the organization key)
    async createOrganization(name, collectionName) {
        const orgKey = SymmetricKey.generate();
        const { pkcs8, spki } = await generateRsaKeyPair();
        const { publicKey } = await this.api.get(`/api/users/${this.userId}/public-key`);
        const res = await this.api.post("/api/organizations", {
            name,
            billingEmail: this.profile.email,
            collectionName: await encryptString(normalizeFolderPath(collectionName), orgKey),
            key: await rsaEncrypt(orgKey.raw, publicKey),
            keys: { publicKey: b64encode(spki), encryptedPrivateKey: await encryptBytes(pkcs8, orgKey) },
            planType: 0,
        });
        return res.id;
    }

    // Gives accepted members the organization key, encrypted with their public key. Returns the members which failed.
    async confirmMembers(organizationId, members) {
        const orgKey = this.baseKeyFor(organizationId);
        const keys = [];
        for (const m of members) {
            const { publicKey } = await this.api.get(`/api/users/${m.userId}/public-key`);
            keys.push({ id: m.id, key: await rsaEncrypt(orgKey.raw, publicKey) });
        }
        const res = await this.api.post(`/api/organizations/${organizationId}/users/confirm`, { keys });
        return (res.data || []).filter((r) => r.error);
    }

    // ----- Collections --------------------------------------------------------------------

    async createCollection(organizationId, path) {
        path = normalizeFolderPath(path);
        const key = this.baseKeyFor(organizationId);
        const raw = await this.api.createCollection(organizationId, await encryptString(path, key));
        const col = await this._addCollection({ ...raw, organizationId, manage: true });
        this.changed("collection");
        return col;
    }

    async ensureCollectionPath(organizationId, path) {
        path = normalizeFolderPath(path);
        const existing = [...this.collections.values()].find((c) => c.organizationId === organizationId && c.path === path);
        if (existing) return existing.id;
        return (await this.createCollection(organizationId, path)).id;
    }

    async renameCollection(collectionId, newPath) {
        const col = this.collections.get(collectionId);
        if (!col) throw new Error("Unknown collection");
        const key = this.baseKeyFor(col.organizationId);
        // The update replaces the access lists, so send the current ones back
        const details = await this.api.collectionDetails(col.organizationId, collectionId);
        const raw = await this.api.updateCollection(col.organizationId, collectionId, {
            name: await encryptString(normalizeFolderPath(newPath), key),
            externalId: details.externalId ?? null,
            groups: (details.groups || []).map((g) => ({
                id: g.id,
                readOnly: !!g.readOnly,
                hidePasswords: !!g.hidePasswords,
                manage: !!g.manage,
            })),
            users: (details.users || []).map((u) => ({
                id: u.id,
                readOnly: !!u.readOnly,
                hidePasswords: !!u.hidePasswords,
                manage: !!u.manage,
            })),
        });
        await this._addCollection({ ...col, ...raw, organizationId: col.organizationId, readOnly: col.readOnly, manage: col.manage, hidePasswords: col.hidePasswords });
        this.changed("collection");
    }

    async deleteCollection(collectionId) {
        const col = this.collections.get(collectionId);
        if (!col) return;
        await this.api.deleteCollection(col.organizationId, collectionId);
        this.collections.delete(collectionId);
        for (const c of this.ciphers.values()) {
            c.collectionIds = c.collectionIds.filter((id) => id !== collectionId);
        }
        this.changed("collection");
    }

    // ----- Search -------------------------------------------------------------------------

    static matches(view, terms, { searchPasswords = false, caseSensitive = false } = {}) {
        const hay = [view.name, view.notes];
        if (view.login) {
            hay.push(view.login.username);
            for (const u of view.login.uris || []) hay.push(u.uri);
            if (searchPasswords) hay.push(view.login.password);
        }
        if (view.typeData) {
            for (const [k, v] of Object.entries(view.typeData)) {
                if (typeof v === "string" && k !== "privateKey") hay.push(v);
            }
        }
        for (const f of view.fields || []) {
            hay.push(f.name);
            if (f.type !== FieldType.Hidden || searchPasswords) hay.push(f.value);
        }
        for (const a of view.attachments || []) hay.push(a.fileName);
        const joined = hay.filter((x) => typeof x === "string").join("\n");
        const text = caseSensitive ? joined : joined.toLowerCase();
        return terms.every((t) => text.includes(t));
    }
}

// Every method which changes the vault is tracked, see `sync()`
for (const name of [
    "saveCipher", "shareCiphers", "setCipherCollections", "moveCiphers", "setFavorite", "trashCiphers", "restoreCiphers",
    "deleteCiphersPermanently", "addAttachment", "deleteAttachment", "createFolder", "ensureFolderPath", "moveFolderPath",
    "deleteFolderPath", "mergeDuplicateFolders", "deleteEmptyFolders", "repairFolderTree", "createCollection",
    "ensureCollectionPath", "renameCollection", "deleteCollection",
]) {
    const method = Vault.prototype[name];
    Vault.prototype[name] = function (...args) {
        return this._op(() => method.apply(this, args));
    };
}

// A deep enough copy of a cipher view for editing
export function cloneView(view) {
    return {
        ...view,
        login: view.login
            ? { ...view.login, uris: (view.login.uris || []).map((u) => ({ ...u })) }
            : null,
        typeData: view.typeData ? { ...view.typeData } : null,
        typeEncryptedKeys: [...(view.typeEncryptedKeys || [])],
        fields: (view.fields || []).map((f) => ({ ...f })),
        passwordHistory: (view.passwordHistory || []).map((h) => ({ ...h })),
        attachments: [...(view.attachments || [])],
        collectionIds: [...(view.collectionIds || [])],
    };
}

export function newCipherView(type, folderId = null) {
    const view = {
        id: null,
        type,
        organizationId: null,
        folderId,
        collectionIds: [],
        favorite: false,
        reprompt: 0,
        edit: true,
        viewPassword: true,
        name: "",
        notes: null,
        login: null,
        typeData: null,
        typeEncryptedKeys: [],
        fields: [],
        passwordHistory: [],
        attachments: [],
        raw: null,
        key: null,
        hasCipherKey: false,
        decryptError: false,
    };
    if (type === CipherType.Login) view.login = { username: null, password: null, totp: null, uris: [], fido2Credentials: null };
    if (type === CipherType.SecureNote) view.typeData = { type: 0 };
    if (TypeFields[type]) {
        view.typeData = {};
        for (const [k] of TypeFields[type]) view.typeData[k] = null;
        view.typeEncryptedKeys = TypeFields[type].map((f) => f[0]);
    }
    return view;
}
