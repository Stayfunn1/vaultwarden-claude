// Bitwarden compatible client side cryptography.
//
// Everything in a Bitwarden/Vaultwarden vault is encrypted by the clients, the server never sees
// plain text values. This module implements the parts of the Bitwarden key hierarchy and the
// EncString format needed by the web manager:
//
//   master password + KDF  -> master key (32 bytes)
//   master key + HKDF      -> stretched master key (enc + mac)  -> decrypts the user key
//   user key (64 bytes)    -> folders, personal ciphers, cipher keys, the RSA private key
//   RSA private key        -> organization keys
//   cipher key (optional)  -> all fields of one cipher and its attachment keys
//
// Only WebCrypto is used, except for Argon2id which needs a WASM implementation (hash-wasm).

const subtle = globalThis.crypto.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const EncType = Object.freeze({
    AesCbc256_B64: 0,
    AesCbc128_HmacSha256_B64: 1,
    AesCbc256_HmacSha256_B64: 2,
    Rsa2048_OaepSha256_B64: 3,
    Rsa2048_OaepSha1_B64: 4,
    Rsa2048_OaepSha256_HmacSha256_B64: 5,
    Rsa2048_OaepSha1_HmacSha256_B64: 6,
});

export const KdfType = Object.freeze({ PBKDF2_SHA256: 0, Argon2id: 1 });

export class CryptoError extends Error {}

// ---------------------------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------------------------

export function utf8(str) {
    return textEncoder.encode(str);
}

export function fromUtf8(bytes) {
    return textDecoder.decode(bytes);
}

export function b64encode(bytes) {
    bytes = toBytes(bytes);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function b64decode(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function b64urlEncode(bytes) {
    return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return b64decode(str);
}

export function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === "string") return utf8(data);
    throw new CryptoError("Unsupported data type");
}

function concat(...arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

export function randomBytes(n) {
    const out = new Uint8Array(n);
    // getRandomValues is limited to 65536 bytes per call
    for (let i = 0; i < n; i += 65536) {
        globalThis.crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
    }
    return out;
}

export function randomUuid() {
    return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export async function sha256(data) {
    return new Uint8Array(await subtle.digest("SHA-256", toBytes(data)));
}

export async function hmac(algorithm, key, data) {
    const k = await subtle.importKey("raw", toBytes(key), { name: "HMAC", hash: algorithm }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", k, toBytes(data)));
}

export async function pbkdf2(password, salt, iterations, length = 32) {
    const key = await subtle.importKey("raw", toBytes(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations },
        key,
        length * 8,
    );
    return new Uint8Array(bits);
}

// HKDF-Expand only (RFC 5869 section 2.3), the way Bitwarden stretches keys.
export async function hkdfExpand(prk, info, length) {
    const infoBytes = toBytes(info);
    const out = new Uint8Array(length);
    let previous = new Uint8Array(0);
    let offset = 0;
    for (let i = 1; offset < length; i++) {
        previous = await hmac("SHA-256", prk, concat(previous, infoBytes, new Uint8Array([i])));
        out.set(previous.subarray(0, Math.min(previous.length, length - offset)), offset);
        offset += previous.length;
    }
    return out;
}

let argon2Impl = null;

// Argon2id(password, salt, memoryKiB, iterations, parallelism, hashLength) -> Uint8Array
// The browser build uses hash-wasm (loaded as a global), tests can inject their own.
export function setArgon2Implementation(fn) {
    argon2Impl = fn;
}

async function argon2id(password, salt, memoryKiB, iterations, parallelism, hashLength) {
    if (argon2Impl) {
        return argon2Impl(password, salt, memoryKiB, iterations, parallelism, hashLength);
    }
    const hashwasm = globalThis.hashwasm;
    if (!hashwasm || !hashwasm.argon2id) {
        throw new CryptoError("Argon2 implementation is not available");
    }
    return hashwasm.argon2id({
        password: toBytes(password),
        salt: toBytes(salt),
        parallelism,
        iterations,
        memorySize: memoryKiB,
        hashLength,
        outputType: "binary",
    });
}

export async function argon2(type, password, salt, memoryKiB, iterations, parallelism, hashLength) {
    // Used by the KeePass importer: kdbx files use Argon2d (KeePass) or Argon2id (KeePassXC)
    const hashwasm = globalThis.hashwasm;
    const fn = type === "argon2d" ? hashwasm?.argon2d : hashwasm?.argon2id;
    if (!fn) {
        if (type !== "argon2d" && argon2Impl) {
            return argon2Impl(password, salt, memoryKiB, iterations, parallelism, hashLength);
        }
        throw new CryptoError("Argon2 implementation is not available");
    }
    return fn({
        password: toBytes(password),
        salt: toBytes(salt),
        parallelism,
        iterations,
        memorySize: memoryKiB,
        hashLength,
        outputType: "binary",
    });
}

// Constant time comparison
function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// ---------------------------------------------------------------------------------------------
// Symmetric keys
// ---------------------------------------------------------------------------------------------

export class SymmetricKey {
    constructor(raw, encKey, macKey) {
        raw = toBytes(raw);
        if (encKey) {
            this.encKey = encKey;
            this.macKey = macKey ?? null;
        } else if (raw.length === 64) {
            this.encKey = raw.slice(0, 32);
            this.macKey = raw.slice(32, 64);
        } else if (raw.length === 32) {
            this.encKey = raw;
            this.macKey = null;
        } else {
            throw new CryptoError(`Invalid symmetric key length ${raw.length}`);
        }
        this.raw = raw;
        this.encType = this.macKey ? EncType.AesCbc256_HmacSha256_B64 : EncType.AesCbc256_B64;
        this._aes = null;
        this._mac = null;
    }

    static generate() {
        return new SymmetricKey(randomBytes(64));
    }

    aesKey() {
        if (!this._aes) {
            this._aes = subtle.importKey("raw", this.encKey, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
        }
        return this._aes;
    }

    macCryptoKey() {
        if (!this._mac) {
            this._mac = subtle.importKey("raw", this.macKey, { name: "HMAC", hash: "SHA-256" }, false, [
                "sign",
                "verify",
            ]);
        }
        return this._mac;
    }

    toB64() {
        return b64encode(this.raw);
    }
}

// ---------------------------------------------------------------------------------------------
// EncString
// ---------------------------------------------------------------------------------------------

const ENCSTRING_RE = /^([0-6])\.([A-Za-z0-9+/=]+)(\|[A-Za-z0-9+/=]+){0,2}$/;

export function isEncString(value) {
    return typeof value === "string" && ENCSTRING_RE.test(value);
}

export function parseEncString(str) {
    if (typeof str !== "string") throw new CryptoError("EncString is not a string");
    const dot = str.indexOf(".");
    let type;
    let rest;
    if (dot === -1) {
        // Very old format without type prefix
        const parts = str.split("|");
        type = parts.length === 3 ? EncType.AesCbc128_HmacSha256_B64 : EncType.AesCbc256_B64;
        rest = parts;
    } else {
        type = parseInt(str.substring(0, dot), 10);
        rest = str.substring(dot + 1).split("|");
    }
    switch (type) {
        case EncType.AesCbc256_B64:
            if (rest.length !== 2) throw new CryptoError("Invalid EncString");
            return { type, iv: b64decode(rest[0]), data: b64decode(rest[1]), mac: null };
        case EncType.AesCbc128_HmacSha256_B64:
        case EncType.AesCbc256_HmacSha256_B64:
            if (rest.length !== 3) throw new CryptoError("Invalid EncString");
            return { type, iv: b64decode(rest[0]), data: b64decode(rest[1]), mac: b64decode(rest[2]) };
        case EncType.Rsa2048_OaepSha256_B64:
        case EncType.Rsa2048_OaepSha1_B64:
            return { type, data: b64decode(rest[0]) };
        case EncType.Rsa2048_OaepSha256_HmacSha256_B64:
        case EncType.Rsa2048_OaepSha1_HmacSha256_B64:
            return { type, data: b64decode(rest[0]), mac: rest[1] ? b64decode(rest[1]) : null };
        default:
            throw new CryptoError(`Unsupported encryption type ${type}`);
    }
}

async function aesDecrypt(key, iv, data) {
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, await key.aesKey(), data));
}

export async function decryptBytes(encString, key) {
    if (!key) throw new CryptoError("No key to decrypt with");
    const parsed = typeof encString === "string" ? parseEncString(encString) : encString;
    switch (parsed.type) {
        case EncType.AesCbc256_B64:
            // A MAC is mandatory when the key has a MAC key, like the Bitwarden clients enforce.
            if (key.macKey) throw new CryptoError("Missing MAC on encrypted value");
            return aesDecrypt(key, parsed.iv, parsed.data);
        case EncType.AesCbc256_HmacSha256_B64: {
            if (!key.macKey) throw new CryptoError("Key has no MAC key");
            const ok = await subtle.verify("HMAC", await key.macCryptoKey(), parsed.mac, concat(parsed.iv, parsed.data));
            if (!ok) throw new CryptoError("MAC verification failed");
            return aesDecrypt(key, parsed.iv, parsed.data);
        }
        case EncType.Rsa2048_OaepSha256_B64:
        case EncType.Rsa2048_OaepSha1_B64:
        case EncType.Rsa2048_OaepSha256_HmacSha256_B64:
        case EncType.Rsa2048_OaepSha1_HmacSha256_B64:
            if (!(key instanceof RsaPrivateKey)) throw new CryptoError("An RSA key is required");
            return key.decrypt(parsed);
        default:
            throw new CryptoError(`Unsupported encryption type ${parsed.type}`);
    }
}

export async function decryptString(encString, key) {
    if (encString === null || encString === undefined || encString === "") return encString ?? null;
    return fromUtf8(await decryptBytes(encString, key));
}

export async function encryptBytes(data, key) {
    if (!key || !key.macKey) throw new CryptoError("A 64 byte key is required to encrypt");
    const iv = randomBytes(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, await key.aesKey(), toBytes(data)));
    const mac = new Uint8Array(await subtle.sign("HMAC", await key.macCryptoKey(), concat(iv, ct)));
    return `${EncType.AesCbc256_HmacSha256_B64}.${b64encode(iv)}|${b64encode(ct)}|${b64encode(mac)}`;
}

export async function encryptString(value, key) {
    if (value === null || value === undefined) return null;
    return encryptBytes(utf8(String(value)), key);
}

// Attachments use a binary variant of the EncString: [type:1][iv:16][mac:32][ciphertext]
export async function encryptFile(data, key) {
    const iv = randomBytes(16);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, await key.aesKey(), toBytes(data)));
    const mac = new Uint8Array(await subtle.sign("HMAC", await key.macCryptoKey(), concat(iv, ct)));
    return concat(new Uint8Array([EncType.AesCbc256_HmacSha256_B64]), iv, mac, ct);
}

export async function decryptFile(data, key) {
    data = toBytes(data);
    const type = data[0];
    if (type === EncType.AesCbc256_HmacSha256_B64) {
        const iv = data.subarray(1, 17);
        const mac = data.subarray(17, 49);
        const ct = data.subarray(49);
        const ok = await subtle.verify("HMAC", await key.macCryptoKey(), mac, concat(iv, ct));
        if (!ok) throw new CryptoError("Attachment MAC verification failed");
        return aesDecrypt(key, iv, ct);
    }
    if (type === EncType.AesCbc256_B64) {
        // Without a MAC the data could have been modified, only allowed for keys without a MAC key
        if (key.macKey) throw new CryptoError("Missing MAC on encrypted attachment");
        return aesDecrypt(key, data.subarray(1, 17), data.subarray(17));
    }
    throw new CryptoError(`Unsupported attachment encryption type ${type}`);
}

// ---------------------------------------------------------------------------------------------
// RSA (organization keys)
// ---------------------------------------------------------------------------------------------

export class RsaPrivateKey {
    constructor(pkcs8) {
        this.pkcs8 = toBytes(pkcs8);
        this._keys = {};
    }

    key(hash) {
        if (!this._keys[hash]) {
            this._keys[hash] = subtle.importKey("pkcs8", this.pkcs8, { name: "RSA-OAEP", hash }, false, ["decrypt"]);
        }
        return this._keys[hash];
    }

    async decrypt(parsed) {
        const sha1 =
            parsed.type === EncType.Rsa2048_OaepSha1_B64 || parsed.type === EncType.Rsa2048_OaepSha1_HmacSha256_B64;
        const hash = sha1 ? "SHA-1" : "SHA-256";
        return new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, await this.key(hash), parsed.data));
    }
}

// A new RSA key pair for an account or an organization: { pkcs8, spki } (DER bytes)
export async function generateRsaKeyPair() {
    const kp = await subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
        true,
        ["encrypt", "decrypt"],
    );
    return {
        pkcs8: new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey)),
        spki: new Uint8Array(await subtle.exportKey("spki", kp.publicKey)),
    };
}

export async function rsaEncrypt(data, publicKeySpkiB64) {
    const key = await subtle.importKey("spki", b64decode(publicKeySpkiB64), { name: "RSA-OAEP", hash: "SHA-1" }, false, [
        "encrypt",
    ]);
    const ct = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, key, toBytes(data)));
    return `${EncType.Rsa2048_OaepSha1_B64}.${b64encode(ct)}`;
}

// ---------------------------------------------------------------------------------------------
// Master key handling
// ---------------------------------------------------------------------------------------------

export function normalizeEmail(email) {
    return String(email).trim().toLowerCase();
}

export async function deriveMasterKey(password, salt, kdf) {
    const saltBytes = utf8(normalizeEmail(salt));
    const pw = utf8(password);
    switch (Number(kdf.kdf ?? kdf.type)) {
        case KdfType.PBKDF2_SHA256:
            return pbkdf2(pw, saltBytes, Number(kdf.kdfIterations ?? kdf.iterations));
        case KdfType.Argon2id: {
            const memoryMiB = Number(kdf.kdfMemory ?? kdf.memory);
            const parallelism = Number(kdf.kdfParallelism ?? kdf.parallelism);
            const iterations = Number(kdf.kdfIterations ?? kdf.iterations);
            const saltHash = await sha256(saltBytes);
            return toBytes(await argon2id(pw, saltHash, memoryMiB * 1024, iterations, parallelism, 32));
        }
        default:
            throw new CryptoError("Unsupported KDF type");
    }
}

// The hash which is sent to the server instead of the password
export async function hashMasterKey(masterKey, password) {
    return b64encode(await pbkdf2(masterKey, utf8(password), 1));
}

export async function stretchMasterKey(masterKey) {
    const enc = await hkdfExpand(masterKey, "enc", 32);
    const mac = await hkdfExpand(masterKey, "mac", 32);
    return new SymmetricKey(concat(enc, mac));
}

// Decrypts the user key ("Key" / profile.key) with the master key
export async function decryptUserKey(encUserKey, masterKey) {
    const parsed = parseEncString(encUserKey);
    let raw;
    if (parsed.type === EncType.AesCbc256_B64) {
        raw = await decryptBytes(parsed, new SymmetricKey(masterKey));
    } else if (parsed.type === EncType.AesCbc256_HmacSha256_B64) {
        raw = await decryptBytes(parsed, await stretchMasterKey(masterKey));
    } else {
        throw new CryptoError("Unsupported user key encryption");
    }
    return new SymmetricKey(raw);
}

// ---------------------------------------------------------------------------------------------
// Misc helpers used by the UI
// ---------------------------------------------------------------------------------------------

export async function uriChecksum(uri) {
    return b64encode(await sha256(utf8(uri)));
}

// PKCE helpers for the SSO flow
export async function pkcePair() {
    const verifier = b64urlEncode(randomBytes(48));
    const challenge = b64urlEncode(await sha256(utf8(verifier)));
    return { verifier, challenge };
}

const CHARSETS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lower: "abcdefghijklmnopqrstuvwxyz",
    digits: "0123456789",
    special: "!@#$%^&*",
    extended: "-_.,:;+=?/~()[]{}<>|'\"`\\",
};
const AMBIGUOUS = /[Il1O0]/g;

function randomInt(max) {
    // Uniform integer in [0, max) using rejection sampling
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    for (;;) {
        globalThis.crypto.getRandomValues(buf);
        if (buf[0] < limit) return buf[0] % max;
    }
}

export function generatePassword(opts = {}) {
    const o = { length: 20, upper: true, lower: true, digits: true, special: true, extended: false, avoidAmbiguous: true, ...opts };
    const sets = [];
    for (const name of ["upper", "lower", "digits", "special", "extended"]) {
        if (!o[name]) continue;
        let chars = CHARSETS[name];
        if (o.avoidAmbiguous) chars = chars.replace(AMBIGUOUS, "");
        sets.push(chars);
    }
    if (!sets.length) throw new CryptoError("Select at least one character set");
    const length = Math.max(Math.min(Number(o.length) || 20, 256), sets.length);
    const all = sets.join("");
    const out = sets.map((s) => s[randomInt(s.length)]);
    while (out.length < length) out.push(all[randomInt(all.length)]);
    // Fisher-Yates shuffle, so the guaranteed characters are not always at the start
    for (let i = out.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out.join("");
}

// Rough strength estimate in bits, only used for the strength bar
export function passwordEntropy(pw) {
    if (!pw) return 0;
    let pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
    const unique = new Set(pw).size;
    return Math.round(Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2));
}

// ---------------------------------------------------------------------------------------------
// TOTP (RFC 6238), supports plain base32 secrets, otpauth:// URIs and steam://
// ---------------------------------------------------------------------------------------------

function base32Decode(input) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const clean = input.toUpperCase().replace(/[\s=-]/g, "");
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) throw new CryptoError("Invalid base32 secret");
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

export function parseTotp(totp) {
    if (!totp) return null;
    let secret = totp.trim();
    let period = 30;
    let digits = 6;
    let algorithm = "SHA-1";
    let steam = false;
    if (/^otpauth:\/\//i.test(secret)) {
        const url = new URL(secret);
        const p = url.searchParams;
        secret = p.get("secret") || "";
        if (p.get("period")) period = parseInt(p.get("period"), 10) || 30;
        if (p.get("digits")) digits = parseInt(p.get("digits"), 10) || 6;
        const alg = (p.get("algorithm") || "SHA1").toUpperCase();
        algorithm = alg === "SHA256" ? "SHA-256" : alg === "SHA512" ? "SHA-512" : "SHA-1";
        if (p.get("encoder") === "steam") steam = true;
    } else if (/^steam:\/\//i.test(secret)) {
        secret = secret.substring(8);
        steam = true;
        digits = 5;
    }
    return { secret, period, digits: Math.min(Math.max(digits, 1), 10), algorithm, steam };
}

export async function totpCode(totp, now = Date.now()) {
    const p = parseTotp(totp);
    if (!p || !p.secret) return null;
    const key = base32Decode(p.secret);
    const counter = Math.floor(now / 1000 / p.period);
    const msg = new Uint8Array(8);
    let c = counter;
    for (let i = 7; i >= 0; i--) {
        msg[i] = c & 0xff;
        c = Math.floor(c / 256);
    }
    const h = await hmac(p.algorithm, key, msg);
    const offset = h[h.length - 1] & 0x0f;
    let bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
    let code;
    if (p.steam) {
        const chars = "23456789BCDFGHJKMNPQRTVWXY";
        code = "";
        for (let i = 0; i < 5; i++) {
            code += chars[bin % chars.length];
            bin = Math.floor(bin / chars.length);
        }
    } else {
        code = String(bin % 10 ** p.digits).padStart(p.digits, "0");
    }
    const remaining = p.period - (Math.floor(now / 1000) % p.period);
    return { code, remaining, period: p.period };
}
