// KeePass (.kdbx and KeePass 2 XML export) to Bitwarden conversion.
//
// Mapping:
//   group tree           -> nested folders ("Parent/Child"), or organization collections
//   Title/UserName/Password/URL/Notes -> name, username, password, first URI, notes
//   additional URLs (KP2A_URL*)        -> additional URIs
//   TOTP (otp, TimeOtp-*, TOTP Seed)   -> authenticator key (TOTP)
//   other string fields  -> custom fields; protected fields become hidden fields
//   attachments          -> encrypted attachments
//   history              -> password history
//   tags / expiry        -> custom fields "Tags" / "Expires"
//   {REF:...} references -> resolved to the referenced value
// Values too large for the Bitwarden clients (long notes or fields) are kept as text attachments.

import { argon2, b64decode, utf8 } from "./bwcrypto.js";
import { CipherType, FieldType, newCipherView, sanitizeSegment, normalizeFolderPath, FOLDER_DELIMITER } from "./vault.js";

// Notes are limited to 10.000 encrypted characters by default, which is about 7400 plain bytes
const MAX_NOTES_BYTES = 7000;
// Keep custom fields well below the 5000 character limit of the Bitwarden server API
const MAX_FIELD_BYTES = 3000;

const STANDARD_FIELDS = new Set(["Title", "UserName", "Password", "URL", "Notes"]);

export const DEFAULT_OPTIONS = {
    includeRecycleBin: false,
    createEmptyGroups: true,
    resolveReferences: true,
    importHistory: true,
    historyLimit: 5,
    tagsField: true,
    expiryField: true,
    targetFolder: "",
};

function kdbx() {
    const k = globalThis.kdbxweb;
    if (!k) throw new Error("The KeePass library could not be loaded");
    return k;
}

let argonInstalled = false;
function installArgon2() {
    if (argonInstalled) return;
    kdbx().CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
        const out = await argon2(
            // kdbx Argon2 types: 0 = Argon2d (KeePass default), 2 = Argon2id (KeePassXC default)
            type === 0 ? "argon2d" : "argon2id",
            new Uint8Array(password),
            new Uint8Array(salt),
            memory,
            iterations,
            parallelism,
            length,
        );
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    });
    argonInstalled = true;
}

function looksLikeXml(bytes) {
    let text = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, "").trimStart();
    return text.startsWith("<?xml") || text.startsWith("<KeePassFile");
}

// Opens a .kdbx database (password and/or key file) or a KeePass 2 XML export
export async function openKeePass(fileBytes, password, keyFileBytes) {
    const k = kdbx();
    installArgon2();
    const bytes = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
    if (looksLikeXml(bytes)) {
        const creds = new k.Credentials(k.ProtectedValue.fromString(""));
        return k.Kdbx.loadXml(new TextDecoder().decode(bytes), creds);
    }
    const pw = password ? k.ProtectedValue.fromString(password) : null;
    const keyFile = keyFileBytes ? toArrayBuffer(keyFileBytes) : null;
    const creds = new k.Credentials(pw, keyFile);
    try {
        return await k.Kdbx.load(toArrayBuffer(bytes), creds);
    } catch (e) {
        const code = e?.code || "";
        if (code === "InvalidKey") throw new Error("Wrong master password or key file");
        if (code === "Unsupported" || /twofish/i.test(String(e?.message))) {
            throw new Error(
                "This database uses an encryption method the browser can not open (e.g. Twofish). " +
                    "Export it from KeePass as 'KeePass XML (2.x)' and import that file instead.",
            );
        }
        throw new Error(`Unable to open the KeePass database: ${e?.message || e}`);
    }
}

function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

function fieldText(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (typeof value.getText === "function") return value.getText();
    return String(value);
}

function isProtected(value) {
    return value && typeof value === "object" && typeof value.getText === "function";
}

function binaryBytes(bin) {
    let value = bin;
    if (value && typeof value === "object" && "hash" in value && "value" in value) value = value.value;
    if (value && typeof value.getBinary === "function") return new Uint8Array(value.getBinary());
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

function uuidHex(uuid) {
    if (!uuid) return "";
    const id = typeof uuid === "string" ? uuid : uuid.id;
    try {
        return Array.from(b64decode(id))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
    } catch {
        return "";
    }
}

function byteLength(str) {
    return utf8(str).length;
}

function truncateBytes(str, maxBytes) {
    const bytes = utf8(str);
    if (bytes.length <= maxBytes) return str;
    // Cut on a character boundary
    let cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
    return cut.replace(/�$/, "");
}

// ----- TOTP ------------------------------------------------------------------------------------

function base32Encode(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = 0;
    let value = 0;
    let out = "";
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
    return out;
}

function hexToBytes(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
}

// Returns { totp, consumed: [field names] } or null
export function extractTotp(fields, title) {
    const get = (k) => (fields.has(k) ? fieldText(fields.get(k)).trim() : "");
    // KeePassXC (2.6+) and KeeTrayTOTP style otpauth URI
    const otp = get("otp");
    if (otp) {
        if (/^otpauth:\/\/totp/i.test(otp)) return { totp: otp, consumed: ["otp"] };
        // "key=SECRET&step=30&size=6&otpHashMode=Sha256" (KeeOtp)
        if (/key=/.test(otp)) {
            const p = new URLSearchParams(otp);
            // Counter based (HOTP) codes are not supported by Bitwarden, keep those as a protected field
            if ((p.get("type") || "totp").toLowerCase() !== "totp") return null;
            const secret = (p.get("key") || "").replace(/\s/g, "");
            const period = p.get("step");
            const digits = p.get("size");
            const alg = (p.get("otpHashMode") || "").toUpperCase().replace("-", "");
            if (secret && ((period && period !== "30") || (digits && digits !== "6") || (alg && alg !== "SHA1"))) {
                const q = new URLSearchParams({ secret });
                if (period) q.set("period", period);
                if (digits) q.set("digits", digits);
                if (alg) q.set("algorithm", alg);
                return { totp: `otpauth://totp/${encodeURIComponent(title || "KeePass")}?${q}`, consumed: ["otp"] };
            }
            if (secret) return { totp: secret, consumed: ["otp"] };
        }
        if (/^otpauth:\/\/hotp/i.test(otp)) return null;
        return { totp: otp.replace(/\s/g, ""), consumed: ["otp"] };
    }
    // KeePass 2.47+ native TOTP
    const variants = [
        ["TimeOtp-Secret-Base32", (s) => s.replace(/\s/g, "").toUpperCase()],
        ["TimeOtp-Secret", (s) => base32Encode(utf8(s))],
        ["TimeOtp-Secret-Hex", (s) => base32Encode(hexToBytes(s))],
        ["TimeOtp-Secret-Base64", (s) => base32Encode(b64decode(s.replace(/\s/g, "")))],
    ];
    for (const [key, conv] of variants) {
        const raw = get(key);
        if (!raw) continue;
        let secret;
        try {
            secret = conv(raw);
        } catch {
            continue;
        }
        const consumed = [key, "TimeOtp-Period", "TimeOtp-Length", "TimeOtp-Algorithm"].filter((k) => fields.has(k));
        const period = get("TimeOtp-Period");
        const digits = get("TimeOtp-Length");
        const alg = get("TimeOtp-Algorithm").replace(/^HMAC-/i, "").replace("-", "").toUpperCase();
        if ((period && period !== "30") || (digits && digits !== "6") || (alg && alg !== "SHA1")) {
            const q = new URLSearchParams({ secret });
            if (period) q.set("period", period);
            if (digits) q.set("digits", digits);
            if (alg) q.set("algorithm", alg);
            return { totp: `otpauth://totp/${encodeURIComponent(title || "KeePass")}?${q}`, consumed };
        }
        return { totp: secret, consumed };
    }
    // Old KeePassXC / TrayTOTP: "TOTP Seed" + "TOTP Settings" ("30;6" or "30;S" for Steam)
    const seed = get("TOTP Seed");
    if (seed) {
        const consumed = ["TOTP Seed", "TOTP Settings"].filter((k) => fields.has(k));
        const settings = get("TOTP Settings");
        if (settings) {
            const [period, size] = settings.split(";");
            if (size === "S") return { totp: `steam://${seed.replace(/\s/g, "")}`, consumed };
            if ((period && period !== "30") || (size && size !== "6")) {
                const q = new URLSearchParams({ secret: seed.replace(/\s/g, "") });
                if (period) q.set("period", period);
                if (size) q.set("digits", size);
                return { totp: `otpauth://totp/${encodeURIComponent(title || "KeePass")}?${q}`, consumed };
            }
        }
        return { totp: seed.replace(/\s/g, ""), consumed };
    }
    return null;
}

// ----- Field references -------------------------------------------------------------------------

const REF_RE = /\{REF:([TUPANI])@([TUPANIO]):([^}]*)\}/gi;
const REF_FIELD = { T: "Title", U: "UserName", P: "Password", A: "URL", N: "Notes" };

class ReferenceResolver {
    constructor(entries) {
        this.entries = entries;
        this.byUuid = new Map(entries.map((e) => [uuidHex(e.uuid), e]));
    }

    find(searchIn, text) {
        searchIn = searchIn.toUpperCase();
        if (searchIn === "I") return this.byUuid.get(text.replace(/[^0-9a-fA-F]/g, "").toUpperCase());
        const needle = text.toLowerCase();
        const values = (e) => {
            if (searchIn === "O") {
                return [...e.fields.entries()].filter(([k]) => !STANDARD_FIELDS.has(k)).map(([, v]) => fieldText(v));
            }
            return [fieldText(e.fields.get(REF_FIELD[searchIn]))];
        };
        // Prefer exact matches, KeePass itself searches for the text inside the field
        return (
            this.entries.find((e) => values(e).some((v) => v.toLowerCase() === needle)) ||
            this.entries.find((e) => values(e).some((v) => v.toLowerCase().includes(needle)))
        );
    }

    resolve(value, depth = 0) {
        if (!value || depth > 10 || !value.includes("{REF:")) return value;
        return value.replace(REF_RE, (match, wanted, searchIn, text) => {
            const target = this.find(searchIn, text);
            if (!target) return match;
            wanted = wanted.toUpperCase();
            const v = wanted === "I" ? uuidHex(target.uuid) : fieldText(target.fields.get(REF_FIELD[wanted]));
            return this.resolve(v, depth + 1);
        });
    }
}

// ----- Conversion -------------------------------------------------------------------------------

function groupPath(group, root, options) {
    const parts = [];
    let g = group;
    while (g && g !== root) {
        parts.unshift(sanitizeSegment(g.name || "(unnamed)"));
        g = g.parentGroup;
    }
    const prefix = normalizeFolderPath(options.targetFolder || "");
    const path = parts.join(FOLDER_DELIMITER);
    return normalizeFolderPath(prefix && path ? `${prefix}${FOLDER_DELIMITER}${path}` : prefix || path);
}

function isInRecycleBin(group, recycleBinUuid) {
    if (!recycleBinUuid) return false;
    for (let g = group; g; g = g.parentGroup) {
        if (g.uuid && g.uuid.equals && g.uuid.equals(recycleBinUuid)) return true;
    }
    return false;
}

function collectGroups(group, out = []) {
    out.push(group);
    for (const g of group.groups || []) collectGroups(g, out);
    return out;
}

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

// Convert an opened database to entries ready for import.
// Returns { entries: [{ view, folderPath, attachments: [{fileName, data}], sourceTitle }], folderPaths, stats, warnings }
export function convertKeePass(db, opts = {}) {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const root = db.getDefaultGroup();
    const recycleBinUuid = db.meta?.recycleBinEnabled !== false ? db.meta?.recycleBinUuid : null;
    const groups = collectGroups(root).filter((g) => options.includeRecycleBin || !isInRecycleBin(g, recycleBinUuid));
    const allEntries = groups.flatMap((g) => g.entries || []);
    const resolver = options.resolveReferences ? new ReferenceResolver(allEntries) : null;
    const resolve = (v) => (resolver ? resolver.resolve(v) : v);

    const warnings = [];
    const stats = { groups: 0, entries: 0, attachments: 0, attachmentBytes: 0, fields: 0, totp: 0, references: 0 };
    const folderPaths = new Set();
    const entries = [];

    for (const group of groups) {
        const path = groupPath(group, root, options);
        if (group !== root) stats.groups++;
        if (path && (options.createEmptyGroups || (group.entries || []).length)) folderPaths.add(path);

        for (const entry of group.entries || []) {
            stats.entries++;
            const fields = entry.fields;
            const get = (k) => fieldText(fields.get(k));
            const rawValues = [...fields.values()].map(fieldText).join("\n");
            if (resolver && rawValues.includes("{REF:")) stats.references++;

            const view = newCipherView(CipherType.Login, null);
            const attachments = [];
            const url = resolve(get("URL")).trim();
            view.name = resolve(get("Title")).trim() || hostOf(url) || url || "(untitled)";
            view.login.username = resolve(get("UserName")) || null;
            view.login.password = resolve(get("Password")) || null;
            if (url) view.login.uris.push({ uri: url, match: null });

            // Notes, overflow goes into an attachment so nothing is lost
            let notes = resolve(get("Notes"));
            if (notes && byteLength(notes) > MAX_NOTES_BYTES) {
                attachments.push({ fileName: "notes.txt", data: utf8(notes) });
                notes = `${truncateBytes(notes, MAX_NOTES_BYTES - 200)}\n\n[... the complete notes are in the attachment notes.txt]`;
            }
            view.notes = notes || null;

            const totp = extractTotp(fields, view.name);
            const consumed = new Set(totp ? totp.consumed : []);
            if (totp) {
                view.login.totp = totp.totp;
                stats.totp++;
            }

            // Custom string fields
            for (const [key, value] of fields.entries()) {
                if (STANDARD_FIELDS.has(key) || consumed.has(key)) continue;
                const text = resolve(fieldText(value));
                if (/^KP2A_URL(_\d+)?$/i.test(key) && text.trim()) {
                    view.login.uris.push({ uri: text.trim(), match: null });
                    continue;
                }
                if (byteLength(text) > MAX_FIELD_BYTES) {
                    const fileName = `${key.replace(/[\\/:*?"<>|]/g, "_")}.txt`;
                    attachments.push({ fileName, data: utf8(text) });
                    view.fields.push({ name: key, value: `[stored in attachment ${fileName}]`, type: FieldType.Text });
                    continue;
                }
                view.fields.push({ name: key, value: text, type: isProtected(value) ? FieldType.Hidden : FieldType.Text });
                stats.fields++;
            }
            if (options.tagsField && entry.tags && entry.tags.length) {
                view.fields.push({ name: "Tags", value: entry.tags.join(", "), type: FieldType.Text });
            }
            if (options.expiryField && entry.times?.expires && entry.times.expiryTime) {
                const d = new Date(entry.times.expiryTime);
                if (!isNaN(d)) view.fields.push({ name: "Expires", value: d.toISOString().substring(0, 10), type: FieldType.Text });
            }

            // Password history: distinct older passwords, newest first
            if (options.importHistory && entry.history && entry.history.length) {
                const seen = new Set([view.login.password || ""]);
                const history = [];
                for (const h of [...entry.history].reverse()) {
                    const pw = resolve(fieldText(h.fields.get("Password")));
                    if (!pw || seen.has(pw)) continue;
                    seen.add(pw);
                    const when = h.times?.lastModTime ? new Date(h.times.lastModTime) : new Date();
                    history.push({ password: pw, lastUsedDate: (isNaN(when) ? new Date() : when).toISOString() });
                }
                view.passwordHistory = history.slice(0, options.historyLimit);
            }

            // Attachments
            for (const [name, bin] of entry.binaries.entries()) {
                const data = binaryBytes(bin);
                if (!data) {
                    warnings.push(`${view.name}: attachment "${name}" could not be read`);
                    continue;
                }
                attachments.push({ fileName: name, data });
                stats.attachments++;
                stats.attachmentBytes += data.byteLength;
            }

            entries.push({ view, folderPath: path, attachments, sourceTitle: view.name });
        }
    }

    // All parent folders, so the tree nests the same way in every Bitwarden client
    for (const p of [...folderPaths]) {
        const parts = p.split(FOLDER_DELIMITER);
        for (let i = 1; i < parts.length; i++) folderPaths.add(parts.slice(0, i).join(FOLDER_DELIMITER));
    }

    return { entries, folderPaths: [...folderPaths].sort(), stats, warnings, name: db.meta?.name || "" };
}
