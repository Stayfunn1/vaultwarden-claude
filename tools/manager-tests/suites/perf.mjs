// Large vault check: 5000 entries in ~500 nested folders (not part of the default run)
import path from "node:path";
import { kdbxweb, register, login, assert, uid, launchBrowser, managerLogin, screenshotPath } from "../lib/helpers.mjs";
import { MANAGER_JS } from "../lib/env.mjs";

const keepass = await import(path.join(MANAGER_JS, "keepass.js"));
const importer = await import(path.join(MANAGER_JS, "importer.js"));

export async function run({ base }) {
    const email = `perf-${uid()}@example.com`;
    const password = "perf master password";
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("x")), "Big");
    const groups = [];
    for (let a = 0; a < 10; a++) {
        const ga = db.createGroup(db.getDefaultGroup(), `Area ${a}`);
        for (let b = 0; b < 7; b++) {
            const gb = db.createGroup(ga, `Team ${b}`);
            groups.push(gb);
            for (let d = 0; d < 6; d++) groups.push(db.createGroup(gb, `Project ${d}`));
        }
    }
    for (let i = 0; i < 5000; i++) {
        const e = db.createEntry(groups[i % groups.length]);
        e.fields.set("Title", `Entry ${i}`);
        e.fields.set("UserName", `user${i}@corp.example`);
        e.fields.set("Password", kdbxweb.ProtectedValue.fromString(`pw-${i}`));
        e.fields.set("URL", `https://app${i % 300}.corp.example/login`);
        e.fields.set("Notes", `Notes for entry ${i}\nsecond line`);
        e.fields.set("Email", `mail${i}@corp.example`);
        e.fields.set("PIN", kdbxweb.ProtectedValue.fromString(String(1000 + (i % 9000))));
    }
    await register(base, email, password);
    const { vault } = await login(base, email, password);
    let t = Date.now();
    const conv = keepass.convertKeePass(db, {});
    const res = await importer.importEntries(vault, conv, {});
    console.log(`  import of ${res.created} entries into ${conv.folderPaths.length} folders: ${Date.now() - t}ms`);
    assert(res.created === 5000, "5000 entries imported");

    const { browser, page } = await launchBrowser();
    try {
        t = Date.now();
        await managerLogin(page, base, email, password);
        await page.waitForSelector(".main-view", { timeout: 180000 });
        console.log(`  login, key derivation, decryption of 5000 entries and rendering: ${Date.now() - t}ms`);
        t = Date.now();
        await page.evaluate(() => window.vwManager.tree.expandAll(true));
        console.log(`  expand all folders: ${Date.now() - t}ms`);
        t = Date.now();
        await page.locator(".menubar-item", { hasText: "View" }).click();
        await page.locator(".menu-item", { hasText: "Show entries of sub folders" }).click();
        await page.waitForFunction(() => window.vwManager.table.rows.length === 5000);
        console.log(`  list all 5000 entries: ${Date.now() - t}ms`);
        await page.screenshot({ path: screenshotPath("20-perf") });
        await page.keyboard.press("Control+f");
        t = Date.now();
        await page.keyboard.type("corp.example/login user12");
        await page.waitForFunction(() => window.vwManager.searchText === "corp.example/login user12");
        console.log(`  search (incl. typing): ${Date.now() - t}ms`);
        await page.keyboard.press("Escape");
        t = Date.now();
        await page.evaluate(() => window.vwManager.moveGroup(window.vwManager.tree.model.nodes.get("folder:Area 3/Team 2"), "Area 3/Team Two"));
        console.log(`  rename a folder with 6 sub folders: ${Date.now() - t}ms`);
        assert((await page.evaluate(() => [...window.vwManager.vault.folders.values()].filter((f) => f.path.startsWith("Area 3/Team Two")).length)) === 7, "folder and its 6 sub folders renamed");
        t = Date.now();
        await page.evaluate(async () => {
            const app = window.vwManager;
            await app.moveEntriesToPath([...app.vault.ciphers.values()].slice(0, 500).map((x) => x.id), "Bulk target");
        });
        console.log(`  move 500 entries: ${Date.now() - t}ms`);
    } finally {
        await browser.close();
    }
}
