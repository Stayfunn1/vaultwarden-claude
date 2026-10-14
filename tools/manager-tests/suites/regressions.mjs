// Regression tests for data safety rules of the manager (no browser needed)
import path from "node:path";
import { c, vaultMod, kdbxweb, register, login, assert, uid } from "../lib/helpers.mjs";
import { MANAGER_JS, startServer, PORT } from "../lib/env.mjs";

const keepass = await import(path.join(MANAGER_JS, "keepass.js"));
const importer = await import(path.join(MANAGER_JS, "importer.js"));
const { CipherType, newCipherView, cloneView } = vaultMod;

async function account(base) {
    const email = `reg-${uid()}@example.com`;
    const password = "regression master password";
    await register(base, email, password);
    return login(base, email, password);
}

export async function run({ base }) {
    const { vault, api } = await account(base);

    // A retried save must not add the old password to the history twice
    const item = newCipherView(CipherType.Login, null);
    item.name = "History";
    item.login.password = "first";
    const saved = await vault.saveCipher(item);
    const edit = cloneView(saved);
    edit.login.password = "second";
    await vault.saveCipher(edit);
    edit.raw = vault.ciphers.get(saved.id).raw; // what the editor does after a save
    await vault.saveCipher(edit);
    const history = vault.ciphers.get(saved.id).passwordHistory.map((h) => h.password);
    assert(history.length === 1 && history[0] === "first", `saving twice records the old password once (${history})`);

    // A server can not inject plain text values or URIs without a valid checksum
    const raw = structuredClone(vault.ciphers.get(saved.id).raw);
    raw.login.uris = [{ uri: await c.encryptString("https://evil.example", vault.ciphers.get(saved.id).key), uriChecksum: null, match: null }];
    let v = await vault.decryptCipher(raw);
    assert(v.login.uris.length === 0, "URI without checksum on an item with cipher key is dropped");
    raw.name = "plain text name";
    v = await vault.decryptCipher(raw);
    assert(v.decryptError, "plain text where an encrypted value is expected is an error");

    // Incomplete SSH keys are hidden by the server: such items must not be editable (saving would erase the key)
    v = await vault.decryptCipher({ ...structuredClone(vault.ciphers.get(saved.id).raw), type: CipherType.SshKey, login: null, sshKey: null });
    assert(v.decryptError, "SSH key item without key data is read-only");

    // A background sync is dropped when the vault changed meanwhile
    const longOp = vault.moveFolderPath("Nothing", "Still nothing").then(() => vault.ensureFolderPath("A/B/C"));
    const applied = await vault.sync(null, { background: true });
    await longOp;
    assert(applied === false, "background sync result is discarded while an operation runs");
    assert(await vault.sync(null, { background: true }), "background sync applies when nothing else runs");
    assert(vault.folderIdForPath("A/B/C"), "state after the operation is kept");

    // KeeOtp settings with a hash algorithm, HOTP stays a field
    const fields = (o) => new Map(Object.entries(o));
    const sha256 = keepass.extractTotp(fields({ otp: "key=JBSWY3DPEHPK3PXP&step=30&size=6&otpHashMode=Sha256" }), "x");
    assert(sha256.totp.includes("algorithm=SHA256"), "KeeOtp hash mode is kept");
    assert(keepass.extractTotp(fields({ otp: "key=JBSWY3DPEHPK3PXP&type=hotp&counter=1" }), "x") === null, "HOTP secrets are not turned into TOTP");

    // An entry whose attachment can not be uploaded is not left behind half imported
    const limited = await startServer({ port: PORT + 5, name: "limited", fresh: true, env: { USER_ATTACHMENT_LIMIT: "50" } });
    try {
        const { vault: v2 } = await account(limited.base);
        const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("x")), "Limits");
        const big = db.createEntry(db.getDefaultGroup());
        big.fields.set("Title", "Big file");
        big.binaries.set("big.bin", await db.createBinary(new Uint8Array(100 * 1024)));
        const small = db.createEntry(db.getDefaultGroup());
        small.fields.set("Title", "Small");
        const res = await importer.importEntries(v2, keepass.convertKeePass(db, {}), { skipExisting: true });
        assert(res.created === 1 && res.failed.length === 1 && res.failed[0].name === "Big file", `entry with a failed attachment is reported as failed (${JSON.stringify(res.failed)})`);
        assert(![...v2.ciphers.values()].some((x) => x.name === "Big file"), "the failed entry was removed again, a new import run can retry it");
    } finally {
        await limited.stop();
    }

    // Restored items can be edited right away
    await vault.trashCiphers([saved.id]);
    await vault.restoreCiphers([saved.id]);
    const restored = cloneView(vault.ciphers.get(saved.id));
    restored.notes = "edited after restore";
    await vault.saveCipher(restored);
    assert(vault.ciphers.get(saved.id).notes === "edited after restore", "a restored item can be edited without a sync");
    void api;
}
