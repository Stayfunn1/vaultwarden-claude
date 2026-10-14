// Browser tests of the manager UI (Playwright + Chromium)
import fs from "node:fs";
import path from "node:path";
import { c, vaultMod, register, login, createOrg, BwCli, assert, uid, launchBrowser, managerLogin, screenshotPath } from "../lib/helpers.mjs";
import { WORK } from "../lib/env.mjs";
import { writeSampleFiles, SAMPLE_PASSWORD, SAMPLE_ENTRIES } from "./keepass-import.mjs";

async function seed(base, email, password) {
    await register(base, email, password);
    const { vault } = await login(base, email, password);
    const f = await vault.ensureFolderPath("Banking/EU");
    await vault.ensureFolderPath("Social");
    for (let i = 0; i < 30; i++) {
        const v = vaultMod.newCipherView(1, i < 10 ? f : null);
        v.name = `Seed ${i}`;
        v.login.username = `seed${i}@example.com`;
        v.login.password = `pw${i}`;
        v.login.uris = [{ uri: `https://site${i}.example.com`, match: null }];
        v.fields = [{ name: "PIN", value: String(1000 + i), type: 1 }];
        await vault.saveCipher(v);
    }
}

async function basics(base) {
    console.log("\n--- folder tree, editor, drag & drop, search, trash, lock, import ---");
    const email = `ui-${uid()}@example.com`;
    const password = "ui master password";
    await seed(base, email, password);
    const { browser, context, page, errors } = await launchBrowser();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await managerLogin(page, base, email, password);
    await page.waitForSelector(".main-view", { timeout: 60000 });
    await page.screenshot({ path: screenshotPath("01-main") });
    assert((await page.locator(".tree-row", { hasText: "Banking" }).count()) === 1, "tree shows folder");
    assert((await page.locator(".et-row").count()) > 0, "table shows rows for root");

    await page.locator(".tree-row", { hasText: "Banking" }).locator(".tree-caret").click();
    await page.locator(".tree-row", { hasText: "EU" }).click();
    assert((await page.locator(".et-row").count()) === 10, "EU folder shows its 10 entries");
    await page.locator(".et-row").first().click();
    assert((await page.locator(".details-pane").innerText()).includes("seed"), "details pane shows entry");
    await page.keyboard.press("Control+b");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert(clip.startsWith("seed"), `Ctrl+B copies user name (${clip})`);

    // Add an entry with a protected custom field
    await page.keyboard.press("Control+i");
    const modal = page.locator(".editor-modal");
    await modal.waitFor();
    await modal.locator(".form-row", { hasText: "Title:" }).locator("input").fill("My new entry");
    await modal.locator(".form-row", { hasText: "User name:" }).locator("input").fill("new-user");
    await modal.locator(".form-row", { hasText: "Password:" }).locator("input").first().fill("S3cret!");
    await modal.locator(".uri-row input").first().fill("https://new.example.com");
    await modal.locator(".tab", { hasText: "Advanced" }).click();
    await modal.locator("button", { hasText: "+ Protected field" }).click();
    await modal.locator(".field-row input[type=text]").first().fill("Security question");
    await modal.locator(".field-row input[type=password]").first().fill("blue");
    await page.screenshot({ path: screenshotPath("02-editor-advanced") });
    await modal.locator("button.primary", { hasText: "OK" }).click();
    await modal.waitFor({ state: "detached" });
    assert((await page.locator(".et-row", { hasText: "My new entry" }).count()) === 1, "new entry is listed in the folder");
    const state = await page.evaluate(() => {
        const v = [...window.vwManager.vault.ciphers.values()].find((x) => x.name === "My new entry");
        return { folder: window.vwManager.vault.folders.get(v.folderId)?.path, field: v.fields[0], key: v.hasCipherKey };
    });
    assert(state.folder === "Banking/EU" && state.field.name === "Security question" && state.field.type === 1 && state.key, "entry saved in folder with protected field and cipher key");

    // Folder operations
    await page.locator(".tree-row", { hasText: "Social" }).click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Add sub folder" }).click();
    await page.locator(".modal input").fill("Friends");
    await page.keyboard.press("Enter");
    await page.locator(".tree-row", { hasText: "Friends" }).waitFor();
    assert(await page.evaluate(() => [...window.vwManager.vault.folders.values()].some((f) => f.path === "Social/Friends")), "sub folder created");

    await page.locator(".tree-row", { hasText: "EU" }).click();
    await page.locator(".et-row", { hasText: "My new entry" }).dragTo(page.locator(".tree-row", { hasText: "Friends" }));
    await page.waitForFunction(() => {
        const v = [...window.vwManager.vault.ciphers.values()].find((x) => x.name === "My new entry");
        return window.vwManager.vault.folders.get(v.folderId)?.path === "Social/Friends";
    });
    assert(true, "drag & drop moves an entry");

    await page.locator(".tree-row", { hasText: "Banking" }).dragTo(page.locator(".tree-row", { hasText: "Social" }).first());
    await page.locator(".modal button.primary", { hasText: "Move" }).click();
    await page.waitForFunction(() => {
        const all = [...window.vwManager.vault.folders.values()].map((f) => f.path);
        return all.includes("Social/Banking/EU") && !all.some((p) => p === "Banking" || p.startsWith("Banking/"));
    });
    const paths = await page.evaluate(() => [...window.vwManager.vault.folders.values()].map((f) => f.path));
    assert(!paths.includes("Banking"), "dragging a folder moves the whole subtree");

    await page.locator(".tree-row", { hasText: "Social" }).first().click();
    await page.keyboard.press("F2");
    await page.locator(".modal input").fill("Personal");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
        const all = [...window.vwManager.vault.folders.values()].map((f) => f.path);
        return all.includes("Personal/Banking/EU") && !all.some((p) => p.startsWith("Social"));
    });
    const paths2 = await page.evaluate(() => [...window.vwManager.vault.folders.values()].map((f) => f.path));
    assert(paths2.includes("Personal/Friends") && !paths2.some((p) => p.startsWith("Social")), "F2 renames the whole subtree");

    // Search
    await page.keyboard.press("Control+f");
    await page.keyboard.type("seed2");
    await page.waitForFunction(() => window.vwManager.searchText === "seed2");
    assert((await page.locator(".et-row").count()) === 11, "search finds seed2 and seed20-29");
    await page.keyboard.press("Escape");

    // Trash and restore
    await page.locator(".tree-row", { hasText: "My vault" }).click();
    await page.locator(".et-row").first().click();
    const name = await page.locator(".et-row.selected .et-name").innerText();
    await page.keyboard.press("Delete");
    await page.locator(".modal button.primary", { hasText: "Move to trash" }).click();
    await page.locator(".modal").waitFor({ state: "detached" });
    await page.locator(".tree-row", { hasText: "Trash" }).click();
    assert((await page.locator(".et-row", { hasText: name }).count()) === 1, "deleted entry is in the trash");
    await page.locator(".et-row", { hasText: name }).click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Restore" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".et-row").length === 0);
    assert(true, "entry restored from the trash");

    // Lock & unlock
    await page.keyboard.press("Control+l");
    await page.waitForSelector("text=Your vault is locked");
    await page.fill("input[type=password]", password);
    await page.click("button[type=submit]");
    await page.waitForSelector(".main-view");
    assert(true, "lock and unlock");

    // KeePass import through the UI
    const { kdbxPath } = await writeSampleFiles();
    await page.locator(".menubar-item", { hasText: "File" }).click();
    await page.locator(".menu-item", { hasText: "Import KeePass" }).click();
    await page.locator(".modal input[type=file]").first().setInputFiles(kdbxPath);
    await page.locator(".modal input[type=password]").fill(SAMPLE_PASSWORD);
    await page.locator(".modal button.primary", { hasText: "Open" }).click();
    await page.waitForSelector("text=entries in", { timeout: 60000 });
    await page.locator(".modal input[placeholder^='e.g. KeePass']").fill("KeePass");
    await page.locator(".modal input[placeholder^='e.g. KeePass']").press("Tab");
    await page.screenshot({ path: screenshotPath("03-import") });
    await page.locator(".modal button.primary", { hasText: "Import" }).click();
    await page.waitForSelector("text=Import finished", { timeout: 180000 });
    assert((await page.locator(".modal").innerText()).includes(`${SAMPLE_ENTRIES} entries imported`), "KeePass import through the UI");
    await page.locator(".modal button.primary").click();
    await page.screenshot({ path: screenshotPath("04-imported") });

    assert(errors.length === 0, `no browser errors (${errors.join(" | ")})`);
    await browser.close();
}

async function twoFactorAndSharing(base) {
    console.log("\n--- two-step login, attachments, sharing by drag & drop ---");
    const email = `ui2-${uid()}@example.com`;
    const password = "ui2 master password";
    const { publicKey } = await register(base, email, password);
    const { vault, api, hash } = await login(base, email, password);
    const gen = await api.post("/api/two-factor/get-authenticator", { masterPasswordHash: hash });
    const secret = gen.authenticator.key;
    await api.post("/api/two-factor/authenticator", { key: secret, token: (await c.totpCode(secret)).code, userVerificationToken: gen.userVerificationToken });
    // The server refuses re-using a code of the same or a neighbouring time step
    const activationStep = Math.floor(Date.now() / 30000);
    const orgId = await createOrg(vault, "Family", publicKey);
    const colId = await vault.ensureCollectionPath(orgId, "Shared/Streaming");
    const item = vaultMod.newCipherView(1, null);
    item.name = "Netflix";
    item.login.username = "family@example.com";
    item.login.password = "netflix-pw";
    await vault.saveCipher(item);

    const { browser, page, errors } = await launchBrowser();
    await managerLogin(page, base, email, password);
    await page.waitForSelector("text=Two-step login");
    await page.fill(".modal input.mono", "000000");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".modal .form-error")?.textContent.length > 0);
    assert(true, "a wrong TOTP code is rejected");
    while (Math.floor(Date.now() / 30000) < activationStep + 2) await new Promise((r) => setTimeout(r, 1000));
    await page.fill(".modal input.mono", (await c.totpCode(secret)).code);
    await page.locator(".modal label", { hasText: "Remember this device" }).locator("input").check();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".main-view", { timeout: 60000 });
    assert(true, "TOTP two-step login");
    await page.evaluate(() => sessionStorage.clear());
    await managerLogin(page, base, email, password);
    await page.waitForSelector(".main-view", { timeout: 60000 });
    assert((await page.locator(".modal").count()) === 0, "a remembered device skips the two-step prompt");

    // Attachments through the editor
    await page.locator(".et-row", { hasText: "Netflix" }).dblclick();
    await page.locator(".editor-modal .tab", { hasText: "Advanced" }).click();
    const fileA = path.join(WORK, "attach-a.txt");
    fs.writeFileSync(fileA, "attachment uploaded through the editor ✓");
    const chooser = page.waitForEvent("filechooser");
    await page.locator(".editor-modal button", { hasText: "Attach files" }).click();
    await (await chooser).setFiles(fileA);
    assert((await page.locator(".editor-modal .tab", { hasText: "Advanced (1)" }).count()) === 1, "pending attachment is counted");
    await page.locator(".editor-modal button.primary", { hasText: "OK" }).click();
    await page.locator(".editor-modal").waitFor({ state: "detached", timeout: 60000 });
    await page.locator(".et-row", { hasText: "Netflix" }).click();
    const download = page.waitForEvent("download");
    await page.locator(".details-pane a", { hasText: "attach-a.txt" }).click();
    const dlPath = path.join(WORK, "dl-a.txt");
    await (await download).saveAs(dlPath);
    assert(fs.readFileSync(dlPath, "utf8") === "attachment uploaded through the editor ✓", "attachment downloads and decrypts in the manager");

    // Share by dragging onto a collection ("Shared" only exists implicitly and starts collapsed)
    await page.locator(".tree-row", { hasText: "Shared" }).locator(".tree-caret").click();
    await page.locator(".et-row", { hasText: "Netflix" }).dragTo(page.locator(".tree-row", { hasText: "Streaming" }));
    await page.waitForSelector("text=Move to organization");
    assert((await page.locator(".modal input[type=checkbox]:checked").count()) === 1, "target collection is preselected");
    await page.locator(".modal button.primary", { hasText: "Move" }).click();
    await page.waitForFunction(() => [...window.vwManager.vault.ciphers.values()].some((v) => v.name === "Netflix" && v.organizationId));
    await page.locator(".tree-row", { hasText: "Streaming" }).click();
    assert((await page.locator(".et-row", { hasText: "Netflix" }).count()) === 1, "shared item shows in the collection");

    // The official CLI (logged in with the API key, it can not answer the TOTP prompt non-interactively)
    const bw = new BwCli(base, "ui-share");
    const apiKey = await api.post("/api/accounts/api-key", { masterPasswordHash: hash });
    bw.env.BW_CLIENTID = `user.${vault.userId}`;
    bw.env.BW_CLIENTSECRET = apiKey.apiKey;
    bw.run(["login", "--apikey"]);
    bw.env.BW_PASSWORD = password;
    bw.session = bw.run(["unlock", "--passwordenv", "BW_PASSWORD", "--raw"]);
    bw.run(["sync"]);
    const shared = bw.json(["list", "items"]).find((i) => i.name === "Netflix");
    assert(shared.organizationId === orgId && shared.collectionIds.includes(colId), "bw: item is in the organization collection");
    assert(shared.login.password === "netflix-pw", "bw: shared password decrypts");
    const out = bw.outDir("share");
    bw.run(["get", "attachment", shared.attachments[0].id, "--itemid", shared.id, "--output", out + "/a.txt"]);
    assert(fs.readFileSync(out + "/a.txt", "utf8") === "attachment uploaded through the editor ✓", "bw: attachment of the shared item decrypts");

    assert(errors.length === 0, `no browser errors (${errors.join(" | ")})`);
    await browser.close();
}

export async function run({ base }) {
    await basics(base);
    await twoFactorAndSharing(base);
}
