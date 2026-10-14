// KeePass import: generates a kdbx with kdbxweb, imports it with the manager code, checks the result with bw
import fs from "node:fs";
import path from "node:path";
import { kdbxweb, register, login, createOrg, BwCli, assert, uid } from "../lib/helpers.mjs";
import { MANAGER_JS, WORK } from "../lib/env.mjs";

const keepass = await import(path.join(MANAGER_JS, "keepass.js"));
const importer = await import(path.join(MANAGER_JS, "importer.js"));
const { IconStore } = await import(path.join(MANAGER_JS, "iconstore.js"));
const P = (s) => kdbxweb.ProtectedValue.fromString(s);

export const SAMPLE_PASSWORD = "kpass";
export const SAMPLE_ENTRIES = 603;
// A 1x1 PNG, used as custom KeePass icon
const PNG_ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// A database with the KeePass features that matter for the migration
export async function buildSampleDb() {
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(P(SAMPLE_PASSWORD)), "My KeePass");
    db.createRecycleBin();
    const root = db.getDefaultGroup();
    const internet = db.createGroup(root, "Internet");
    const mail = db.createGroup(internet, "Mail");
    const slash = db.createGroup(root, "Work/Projects");
    db.createGroup(root, "Empty group");

    internet.icon = 1; // World
    const customIcon = kdbxweb.KdbxUuid.random();
    db.meta.customIcons.set(customIcon.id, { data: new Uint8Array(PNG_ICON).buffer, name: "Jira" });

    const e1 = db.createEntry(mail);
    e1.icon = 19; // E-mail
    e1.fields.set("Title", "Gmail");
    e1.fields.set("UserName", "alice@gmail.com");
    e1.fields.set("Password", P("old-password"));
    e1.fields.set("URL", "https://mail.google.com");
    e1.fields.set("Notes", "personal mail");
    e1.times.creationTime = new Date("2015-03-04T05:06:07Z");
    e1.times.lastModTime = new Date("2017-01-02T03:04:05Z");
    e1.pushHistory();
    e1.fields.set("Password", P("gmail-pass-2"));
    e1.times.lastModTime = new Date("2019-08-09T10:11:12Z");
    e1.fields.set("Recovery email", "alice.backup@example.com");
    e1.fields.set("Security answer", P("blue whale"));
    e1.fields.set("otp", "otpauth://totp/Gmail:alice?secret=JBSWY3DPEHPK3PXP&issuer=Gmail");
    e1.fields.set("KP2A_URL_1", "https://accounts.google.com");
    e1.tags = ["mail", "important"];
    e1.times.expires = true;
    e1.times.expiryTime = new Date("2031-05-06T00:00:00Z");
    e1.binaries.set("readme.txt", await db.createBinary(new TextEncoder().encode("hello attachment")));
    e1.binaries.set("blob.bin", await db.createBinary(new Uint8Array(200000).map((_, i) => i % 251)));

    const e2 = db.createEntry(slash);
    e2.customIcon = customIcon;
    e2.fields.set("Title", "Jira");
    e2.fields.set("UserName", "{REF:U@I:" + Buffer.from(e1.uuid.id, "base64").toString("hex").toUpperCase() + "}");
    e2.fields.set("Password", P("{REF:P@T:Gmail}"));
    e2.fields.set("URL", "https://jira.example.com");
    e2.fields.set("TimeOtp-Secret-Base32", P("GEZDGNBVGY3TQOJQ"));
    e2.fields.set("TimeOtp-Period", "60");
    e2.fields.set("Notes", "x".repeat(9000));
    e2.fields.set("Big field", "y".repeat(5000));

    const e3 = db.createEntry(root);
    e3.fields.set("Title", "");
    e3.fields.set("UserName", "root-user");
    e3.fields.set("URL", "https://root.example.net/path");
    e3.times.creationTime = new Date("2099-01-01T00:00:00Z"); // a broken date in the future

    const trashed = db.createEntry(root);
    trashed.fields.set("Title", "Deleted entry");
    db.remove(trashed);

    const bulk = db.createGroup(internet, "Bulk");
    for (let i = 0; i < 600; i++) {
        const e = db.createEntry(bulk);
        e.fields.set("Title", `Site ${i}`);
        e.fields.set("UserName", `user${i}`);
        e.fields.set("Password", P(`pw-${i}`));
        e.fields.set("Email", `user${i}@example.com`);
        e.times.creationTime = new Date(Date.UTC(2012, 0, 1 + (i % 28)));
        e.times.lastModTime = new Date(Date.UTC(2013, 5, 1 + (i % 28)));
    }
    return db;
}

export async function writeSampleFiles() {
    const db = await buildSampleDb();
    const kdbxPath = path.join(WORK, "sample.kdbx");
    const xmlPath = path.join(WORK, "sample.xml");
    fs.writeFileSync(kdbxPath, new Uint8Array(await db.save()));
    fs.writeFileSync(xmlPath, await db.saveXml(true));
    return { kdbxPath, xmlPath };
}

export async function run({ base }) {
    const { kdbxPath, xmlPath } = await writeSampleFiles();
    const kdbxBytes = new Uint8Array(fs.readFileSync(kdbxPath));

    // Conversion
    const opened = await keepass.openKeePass(kdbxBytes, SAMPLE_PASSWORD);
    const conv = keepass.convertKeePass(opened, {});
    assert(conv.entries.length === SAMPLE_ENTRIES, "all entries except the recycle bin are converted");
    assert(conv.folderPaths.includes("Internet/Mail") && conv.folderPaths.includes("Internet"), "nested folder paths");
    assert(conv.folderPaths.includes("Work∕Projects"), "slash in group name does not create nesting");
    assert(conv.folderPaths.includes("Empty group"), "empty groups kept");
    const g = conv.entries.find((e) => e.view.name === "Gmail").view;
    assert(g.login.password === "gmail-pass-2" && g.passwordHistory[0].password === "old-password", "history converted");
    assert(g.login.totp.startsWith("otpauth://"), "otp field becomes TOTP");
    assert(g.login.uris.length === 2, "KP2A_URL becomes an extra URI");
    assert(g.fields.find((f) => f.name === "Security answer").type === 1, "protected field becomes hidden field");
    assert(g.fields.find((f) => f.name === "Recovery email").type === 0, "plain field becomes text field");
    assert(g.fields.find((f) => f.name === "Tags").value === "mail, important", "tags field");
    assert(g.fields.find((f) => f.name === "Expires").value === "2031-05-06", "expiry field");
    const j = conv.entries.find((e) => e.view.name === "Jira");
    assert(j.view.login.username === "alice@gmail.com" && j.view.login.password === "gmail-pass-2", "field references resolved");
    assert(j.view.login.totp.includes("period=60"), "KeePass TimeOtp with custom period");
    assert(j.attachments.some((a) => a.fileName === "notes.txt") && j.view.notes.length < 7100, "long notes moved to attachment");
    assert(j.attachments.some((a) => a.fileName === "Big field.txt"), "long field moved to attachment");
    assert(conv.entries.some((e) => e.view.name === "root.example.net"), "untitled entry named after host");
    assert(conv.stats.icons === 3, "3 icons found (2 entries, 1 group)");
    assert(conv.entries.find((e) => e.view.name === "Gmail").icon?.standard === 19, "standard entry icon");
    assert(j.icon?.image === `data:image/png;base64,${PNG_ICON.toString("base64")}`, "custom entry icon as PNG");
    assert(conv.groupIcons.get("Internet")?.standard === 1, "group icon");
    assert(!conv.entries.find((e) => e.view.name === "Site 1").icon, "default icons are not stored");
    assert(keepass.convertKeePass(opened, { importIcons: false }).stats.icons === 0, "icons can be left out");
    const gc = conv.entries.find((e) => e.view.name === "Gmail");
    assert(gc.dates.created === "2015-03-04T05:06:07.000Z" && gc.dates.modified === "2019-08-09T10:11:12.000Z", "creation and modification date");
    assert(gc.view.login.passwordRevisionDate === "2019-08-09T10:11:12.000Z", "date of the last password change from the history");
    assert(!conv.entries.find((e) => e.view.name === "Site 1").view.login.passwordRevisionDate, "no password change date without history");
    assert(!keepass.convertKeePass(opened, { importDates: false }).entries[0].dates, "dates can be left out");
    let wrongPw = null;
    try {
        await keepass.openKeePass(kdbxBytes, "wrong");
    } catch (e) {
        wrongPw = e.message;
    }
    assert(wrongPw === "Wrong master password or key file", "wrong KeePass password is reported");

    const xmlConv = keepass.convertKeePass(await keepass.openKeePass(fs.readFileSync(xmlPath), ""), {});
    assert(xmlConv.entries.length === SAMPLE_ENTRIES, "XML export converts the same entries");
    assert(xmlConv.entries.find((e) => e.view.name === "Gmail").view.fields.find((f) => f.name === "Security answer").type === 1, "XML protected field stays hidden");
    assert(xmlConv.entries.find((e) => e.view.name === "Gmail").attachments.length === 2, "XML attachments");
    assert(xmlConv.entries.find((e) => e.view.name === "Jira").icon?.image?.startsWith("data:image/png"), "XML custom icon");
    assert(xmlConv.entries.find((e) => e.view.name === "Gmail").dates?.created === "2015-03-04T05:06:07.000Z", "XML dates");

    // Import into a personal vault
    const email = `import-${uid()}@example.com`;
    const password = "import master password";
    const { publicKey } = await register(base, email, password);
    const { vault } = await login(base, email, password);
    await vault.ensureFolderPath("Internet"); // an existing folder must be reused
    const icons = new IconStore(vault);
    await icons.load();
    const res = await importer.importEntries(vault, keepass.convertKeePass(opened, {}), { skipExisting: true, icons });
    assert(res.created === SAMPLE_ENTRIES && res.failed.length === 0, "all entries imported");
    assert(res.icons === 3, "icons stored");
    const reloaded = new IconStore(vault);
    await reloaded.load();
    const byName = (name, orgId = null) => [...vault.ciphers.values()].find((c) => c.name === name && (c.organizationId || null) === orgId);
    assert(reloaded.itemIcon(byName("Gmail"))?.standard === 19, "standard icon of the imported entry");
    assert(reloaded.itemIcon(byName("Jira"))?.image?.startsWith("data:image/png"), "custom icon of the imported entry");
    const internetFolder = [...vault.folders.values()].find((f) => f.path === "Internet");
    assert(reloaded.groupIcon(internetFolder.id, null)?.standard === 1, "icon of the imported folder");
    const iso = (d) => (d ? new Date(d).toISOString() : null);
    assert(iso(byName("Gmail").creationDate) === "2015-03-04T05:06:07.000Z" && iso(byName("Gmail").revisionDate) === "2019-08-09T10:11:12.000Z", "dates kept for an entry with attachments");
    assert(iso(byName("Site 3").creationDate) === "2012-01-04T00:00:00.000Z" && iso(byName("Site 3").revisionDate) === "2013-06-04T00:00:00.000Z", "dates kept for entries of the bulk import");
    assert(byName("Gmail").login.passwordRevisionDate?.startsWith("2019-08-09"), "password change date kept");
    const future = byName("root.example.net");
    assert(new Date(future.creationDate) <= new Date() && new Date(future.revisionDate) >= new Date(future.creationDate), "dates in the future are not accepted");
    // A normal update can not change the dates
    const gmailView = byName("Gmail");
    const req = await vault.encryptCipher(gmailView);
    await vault.api.put(`/api/ciphers/${gmailView.id}`, { ...req, creationDate: "2000-01-01T00:00:00Z", revisionDate: "2000-01-01T00:00:00Z" });
    await vault.sync();
    assert(iso(byName("Gmail").creationDate) === "2015-03-04T05:06:07.000Z" && new Date(byName("Gmail").revisionDate) > new Date("2020-01-01"), "dates sent with an update are ignored, the update gets the current time");
    const stored = await vault.api.get("/api/manager/icons");
    assert(stored.personal.data.startsWith("2.") && !stored.personal.data.includes("data:image"), "icons are stored encrypted");
    assert(res.attachments === 4, "all attachments uploaded");
    assert([...vault.folders.values()].filter((f) => f.path === "Internet").length === 1, "existing folder reused, not duplicated");
    const again = await importer.importEntries(vault, keepass.convertKeePass(opened, {}), { skipExisting: true });
    assert(again.created === 0 && again.skipped === SAMPLE_ENTRIES, "re-import skips existing entries");

    const bw = new BwCli(base, "import");
    bw.login(email, password);
    const items = bw.json(["list", "items"]);
    const fmap = new Map(bw.json(["list", "folders"]).map((f) => [f.id, f.name]));
    assert(items.length === SAMPLE_ENTRIES, "bw sees all imported items");
    const bg = items.find((i) => i.name === "Gmail");
    assert(fmap.get(bg.folderId) === "Internet/Mail", "bw: item in nested folder");
    assert(bg.fields.find((f) => f.name === "Security answer").value === "blue whale", "bw: hidden field value");
    assert(bg.passwordHistory[0].password === "old-password", "bw: password history");
    assert(bg.attachments.length === 2, "bw: attachments present");
    assert(iso(bg.creationDate) === "2015-03-04T05:06:07.000Z", "bw: original creation date");
    const site = items.find((i) => i.name === "Site 3");
    assert(iso(site.creationDate) === "2012-01-04T00:00:00.000Z" && iso(site.revisionDate) === "2013-06-04T00:00:00.000Z", "bw: original creation and revision date");
    const out = bw.outDir("import");
    const blob = bg.attachments.find((a) => a.fileName === "blob.bin");
    bw.run(["get", "attachment", blob.id, "--itemid", bg.id, "--output", out + "/blob.bin"]);
    const blobData = fs.readFileSync(out + "/blob.bin");
    assert(blobData.length === 200000 && blobData[1000] === 1000 % 251, "bw: binary attachment content intact");
    const bj = items.find((i) => i.name === "Jira");
    bw.run(["get", "attachment", bj.attachments.find((a) => a.fileName === "notes.txt").id, "--itemid", bj.id, "--output", out + "/notes.txt"]);
    assert(fs.readFileSync(out + "/notes.txt", "utf8") === "x".repeat(9000), "bw: full notes in attachment");
    assert(bw.run(["get", "totp", bj.id]).length === 6, "bw: generates TOTP code for imported secret");

    // Import into an organization
    const orgId = await createOrg(vault, "Team", publicKey);
    const orgRes = await importer.importEntries(vault, keepass.convertKeePass(opened, { targetFolder: "KeePass" }), { organizationId: orgId, icons });
    assert(orgRes.created === SAMPLE_ENTRIES && orgRes.failed.length === 0, "organization import");
    await reloaded.load();
    assert(reloaded.itemIcon(byName("Gmail", orgId))?.standard === 19, "organization entry icon");
    assert(iso(byName("Gmail", orgId).creationDate) === "2015-03-04T05:06:07.000Z" && iso(byName("Site 3", orgId).revisionDate) === "2013-06-04T00:00:00.000Z", "organization import keeps the dates");
    assert(reloaded.itemIcon(byName("Gmail"))?.standard === 19, "personal icons kept");
    bw.run(["sync"]);
    const orgItems = bw.json(["list", "items", "--organizationid", orgId]);
    assert(orgItems.length === SAMPLE_ENTRIES, "bw sees all organization items");
    const cmap = new Map(bw.json(["list", "org-collections", "--organizationid", orgId]).map((x) => [x.id, x.name]));
    const og = orgItems.find((i) => i.name === "Gmail");
    assert(og.collectionIds.map((id) => cmap.get(id)).includes("KeePass/Internet/Mail"), "bw: org item in nested collection");
    bw.run(["get", "attachment", og.attachments.find((a) => a.fileName === "readme.txt").id, "--itemid", og.id, "--output", out + "/readme.txt"]);
    assert(fs.readFileSync(out + "/readme.txt", "utf8") === "hello attachment", "bw: org attachment content");
}
