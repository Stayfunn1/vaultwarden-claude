// Compatibility of the manager's encryption with the official Bitwarden CLI, in both directions
import fs from "node:fs";
import path from "node:path";
import { vaultMod, register, login, createOrg, BwCli, assert, uid } from "../lib/helpers.mjs";

const { CipherType, FieldType, newCipherView, cloneView } = vaultMod;

async function scenario(base, kdf, label) {
    console.log(`\n--- ${label} ---`);
    const email = `interop-${label}-${uid()}@example.com`;
    const password = "correct horse battery staple 1";
    const { publicKey } = await register(base, email, password, kdf);
    const { vault } = await login(base, email, password);
    assert(vault.userKey && vault.privateKey, "unlocked user key and private key");

    // Items created by the manager, read by bw
    const folderId = await vault.ensureFolderPath("Banking/Online/EU");
    assert(vault.folderIdForPath("Banking") && vault.folderIdForPath("Banking/Online"), "parent folders created");

    const login1 = newCipherView(CipherType.Login, folderId);
    login1.name = "Bank – ünïcødé ✓";
    login1.notes = "line1\nline2";
    login1.login.username = "alice";
    login1.login.password = "p@ss w0rd";
    login1.login.totp = "JBSWY3DPEHPK3PXP";
    login1.login.uris = [{ uri: "https://bank.example.com/login", match: null }, { uri: "https://m.bank.example.com", match: 1 }];
    login1.fields = [
        { name: "Email", value: "alice@example.com", type: FieldType.Text },
        { name: "PIN", value: "1234", type: FieldType.Hidden },
        { name: "Active", value: "true", type: FieldType.Boolean },
    ];
    const saved = await vault.saveCipher(login1);
    assert(saved.hasCipherKey, "new item has its own cipher key");
    await vault.addAttachment(saved.id, "statement.pdf", new TextEncoder().encode("%PDF-1.4 fake pdf contents"));

    const note = newCipherView(CipherType.SecureNote, null);
    note.name = "Server notes";
    note.notes = "secret note";
    await vault.saveCipher(note);

    const card = newCipherView(CipherType.Card, null);
    card.name = "Visa";
    Object.assign(card.typeData, { cardholderName: "Alice", number: "4111111111111111", expMonth: "12", expYear: "2030", code: "123", brand: "Visa" });
    await vault.saveCipher(card);

    const bw = new BwCli(base, `interop-${label}`);
    bw.login(email, password);
    const items = bw.json(["list", "items"]);
    const folders = bw.json(["list", "folders"]);
    assert(folders.some((f) => f.name === "Banking/Online/EU"), "bw decrypts nested folder name");
    const bwLogin = items.find((i) => i.name === "Bank – ünïcødé ✓");
    assert(bwLogin, "bw decrypts item name with unicode");
    assert(bwLogin.login.username === "alice" && bwLogin.login.password === "p@ss w0rd", "bw decrypts username/password");
    assert(bwLogin.login.totp === "JBSWY3DPEHPK3PXP", "bw decrypts TOTP");
    assert(bwLogin.login.uris.length === 2 && bwLogin.login.uris[0].uri === "https://bank.example.com/login", "bw keeps URIs (checksums valid)");
    assert(bwLogin.notes === "line1\nline2", "bw decrypts notes");
    assert(bwLogin.fields.length === 3 && bwLogin.fields[1].value === "1234" && bwLogin.fields[1].type === 1, "bw decrypts custom fields");
    assert(bwLogin.folderId === folderId, "item is in the folder");
    assert(bwLogin.attachments?.length === 1 && bwLogin.attachments[0].fileName === "statement.pdf", "bw decrypts attachment name");
    const out = bw.outDir("attachments");
    bw.run(["get", "attachment", bwLogin.attachments[0].id, "--itemid", bwLogin.id, "--output", out + "/"]);
    assert(fs.readFileSync(path.join(out, "statement.pdf"), "utf8") === "%PDF-1.4 fake pdf contents", "bw decrypts attachment contents");
    const bwCard = items.find((i) => i.name === "Visa");
    assert(bwCard.card.number === "4111111111111111" && bwCard.card.code === "123", "bw decrypts card");
    assert(items.find((i) => i.name === "Server notes")?.notes === "secret note", "bw decrypts secure note");

    // Items created by bw, read and edited by the manager
    const tmpl = {
        organizationId: null,
        collectionIds: null,
        folderId: null,
        type: 1,
        name: "Created by bw",
        notes: "bw notes",
        favorite: true,
        fields: [{ name: "Recovery", value: "abc def", type: 1, linkedId: null }],
        login: { uris: [{ match: null, uri: "https://bw.example.org" }], username: "bob", password: "old-pass", totp: null },
        secureNote: null,
        card: null,
        identity: null,
        reprompt: 0,
    };
    const created = JSON.parse(bw.run(["create", "item", Buffer.from(JSON.stringify(tmpl)).toString("base64")]));
    const attFile = path.join(out, "bw-upload.txt");
    fs.writeFileSync(attFile, "uploaded by bw");
    bw.run(["create", "attachment", "--file", attFile, "--itemid", created.id]);

    await vault.sync();
    const v = vault.ciphers.get(created.id);
    assert(v && !v.decryptError, "manager decrypts item created by bw");
    assert(v.login.username === "bob" && v.login.password === "old-pass" && v.favorite, "manager reads bw login fields");
    assert(v.login.uris[0].uri === "https://bw.example.org", "manager validates bw URI checksum");
    assert(v.fields[0].value === "abc def", "manager reads bw hidden field");
    const dl = await vault.downloadAttachment(created.id, v.attachments[0].id);
    assert(new TextDecoder().decode(dl.data) === "uploaded by bw", "manager decrypts bw attachment");

    const edit = cloneView(v);
    edit.login.password = "new-pass";
    edit.fields.push({ name: "Extra", value: "x", type: FieldType.Text });
    await vault.saveCipher(edit);
    bw.run(["sync"]);
    const again = bw.json(["get", "item", created.id]);
    assert(again.login.password === "new-pass", "bw sees password changed by manager");
    assert(again.passwordHistory?.[0]?.password === "old-pass", "password history recorded");
    assert(again.fields.length === 2, "bw sees added custom field");
    assert(again.attachments.length === 1, "attachment still present after edit");
    bw.run(["get", "attachment", again.attachments[0].id, "--itemid", created.id, "--output", out + "/again.txt"]);
    assert(fs.readFileSync(path.join(out, "again.txt"), "utf8") === "uploaded by bw", "attachment still decrypts after edit");

    // Folder operations
    await vault.moveFolderPath("Banking", "Finance/Banking");
    bw.run(["sync"]);
    const f2 = bw.json(["list", "folders"]).map((f) => f.name);
    assert(f2.includes("Finance/Banking/Online/EU") && !f2.includes("Banking"), "moving a folder renames the whole subtree");
    assert(f2.includes("Finance"), "new parent folder created");
    assert(bw.json(["get", "item", saved.id]).folderId === folderId, "items keep their folder after a subtree move");

    // Organizations
    const orgId = await createOrg(vault, `Org ${label}`, publicKey);
    const colId = await vault.ensureCollectionPath(orgId, "Shared/Team");
    await vault.shareCiphers([saved.id, created.id], orgId, [colId]);
    await vault.sync();
    bw.run(["sync"]);
    const shared = bw.json(["get", "item", saved.id]);
    assert(shared.organizationId === orgId && shared.collectionIds.includes(colId), "bw sees item moved to organization collection");
    assert(shared.login.password === "p@ss w0rd" && shared.fields.length === 3, "bw decrypts shared item");
    bw.run(["get", "attachment", shared.attachments[0].id, "--itemid", saved.id, "--output", out + "/shared.pdf"]);
    assert(fs.readFileSync(path.join(out, "shared.pdf"), "utf8").startsWith("%PDF"), "bw decrypts attachment of shared item");
    assert(bw.json(["list", "org-collections", "--organizationid", orgId]).some((x) => x.name === "Shared/Team"), "bw decrypts collection name");

    // Deleting a folder tree, keeping the entries
    await vault.deleteFolderPath("Finance", "keep");
    bw.run(["sync"]);
    assert(!bw.json(["list", "folders"]).some((f) => f.name.startsWith("Finance")), "folder subtree deleted");
    assert(bw.json(["list", "items"]).some((i) => i.id === saved.id), "items kept when deleting folder in keep mode");
}

export async function run({ base }) {
    await scenario(base, { kdf: 0, kdfIterations: 600000 }, "pbkdf2");
    await scenario(base, { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 4 }, "argon2id");
}
