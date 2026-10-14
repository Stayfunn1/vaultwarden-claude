// Windows (movable, resizable, minimizable entry windows with a taskbar) and the Options dialog
import { vaultMod, register, login, assert, uid, launchBrowser, managerLogin, screenshotPath } from "../lib/helpers.mjs";

export async function run({ base }) {
    const email = `windows-${uid()}@example.com`;
    const password = "windows master password";
    await register(base, email, password);
    const { vault } = await login(base, email, password);
    const folder = await vault.ensureFolderPath("Servers");
    for (const [name, pw] of [["Alpha", "alpha-pw-1!"], ["Bravo", "bravo-pw-2#"], ["Charlie", "charlie-pw-3$"]]) {
        const v = vaultMod.newCipherView(1, folder);
        v.name = name;
        v.login.username = `${name.toLowerCase()}@example.com`;
        v.login.password = pw;
        v.notes = `Notes of ${name}`;
        await vault.saveCipher(v);
    }

    const { browser, context, page, errors } = await launchBrowser();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    const row = (name) => page.locator(".et-row", { hasText: name });
    // Windows may cover the middle of the list, rows are clicked at their left end
    const clickRow = (name) => row(name).click({ position: { x: 20, y: 6 } });
    const dragBy = async (loc, dx, dy) => {
        const t = await loc.locator(".modal-title").boundingBox();
        await page.mouse.move(t.x + 60, t.y + t.height / 2);
        await page.mouse.down();
        await page.mouse.move(t.x + 60 + dx, t.y + t.height / 2 + dy, { steps: 5 });
        await page.mouse.up();
    };
    const win = (name) => page.locator(".window", { hasText: `${name} – Edit Login` }).first();
    const task = (name) => page.locator(".taskbar .task", { hasText: name });
    const box = (loc) => loc.boundingBox();
    const menu = async (top, item) => {
        await page.locator(".menubar-item", { hasText: top }).click();
        await page.locator(".menu-item", { hasText: item }).first().click();
    };
    try {
        await managerLogin(page, base, email, password);
        await page.waitForSelector(".main-view", { timeout: 60000 });
        await page.locator(".tree-row", { hasText: "Servers" }).click();

        console.log("\n--- Entry windows ---");
        await clickRow("Alpha");
        await page.keyboard.press("Enter");
        await win("Alpha").waitFor();
        assert((await task("Alpha").count()) === 1, "an entry opens in a window with a taskbar button");
        const before = await box(win("Alpha"));
        await dragBy(win("Alpha"), 450, 40);
        const after = await box(win("Alpha"));
        assert(Math.abs(after.x - (before.x + 450)) < 3 && Math.abs(after.y - (before.y + 40)) < 3, "a window is moved by dragging its title bar");
        await clickRow("Bravo");
        assert((await page.locator(".details-pane").innerText()).includes("bravo@example.com"), "the main window stays usable while a window is open");
        await page.keyboard.press("Enter");
        await win("Bravo").waitFor();
        assert((await page.locator(".window").count()) === 2, "a second entry opens next to the first one");
        await dragBy(win("Bravo"), 450, 80);
        await clickRow("Alpha");
        await page.keyboard.press("Enter");
        assert((await page.locator(".window").count()) === 2, "opening an entry again shows its open window");
        assert(await win("Alpha").evaluate((el) => el.classList.contains("active")), "... and brings it to the front");

        // Resize with the corner, the size is remembered for the next entry window
        await dragBy(win("Alpha"), -500, -40);
        const placed = await box(win("Alpha"));
        await page.mouse.move(placed.x + placed.width - 3, placed.y + placed.height - 3);
        await page.mouse.down();
        await page.mouse.move(placed.x + placed.width - 103, placed.y + placed.height - 63, { steps: 5 });
        await page.mouse.up();
        const resized = await box(win("Alpha"));
        assert(Math.abs(resized.width - (placed.width - 100)) < 4 && Math.abs(resized.height - (placed.height - 60)) < 4, "a window is resized with its corner");

        await win("Alpha").locator("button[title=Minimize]").click();
        assert(await win("Alpha").isHidden(), "minimize hides the window");
        assert(await task("Alpha").evaluate((el) => el.classList.contains("minimized")), "the taskbar shows it as minimized");
        await task("Alpha").click();
        assert(await win("Alpha").isVisible(), "the taskbar button restores it");

        await win("Bravo").locator(".modal-title").dblclick();
        const area = await page.evaluate(() => document.querySelector(".window-layer").getBoundingClientRect().toJSON());
        const max = await box(win("Bravo"));
        assert(Math.abs(max.width - area.width) < 2 && Math.abs(max.height - area.height) < 2, "double-clicking the title bar maximizes");
        assert(await page.locator(".taskbar").isVisible(), "a maximized window leaves the taskbar visible");
        await win("Bravo").locator(".modal-title").dblclick();

        await menu("Windows", "Side by side");
        const a = await box(win("Alpha"));
        const b = await box(win("Bravo"));
        assert(Math.abs(a.y - b.y) < 2 && Math.abs(a.width - b.width) < 2 && Math.abs(Math.abs(a.x - b.x) - a.width) < 3, "Windows → Side by side");
        await page.screenshot({ path: screenshotPath("40-windows-side-by-side") });

        // Saving in a window
        await win("Bravo").locator(".form-row", { hasText: "Title:" }).locator("input").fill("Bravo renamed");
        assert((await task("Bravo renamed").count()) === 1, "the window title follows the entry title");
        await page.locator(".window", { hasText: "Bravo renamed – Edit Login" }).locator("button.primary", { hasText: "OK" }).click();
        await row("Bravo renamed").waitFor();
        assert((await page.locator(".window").count()) === 1, "OK saves and closes the window");

        // Keyboard shortcuts of the main window do not fire inside a window
        await win("Alpha").locator(".form-row", { hasText: "User name:" }).locator("input").click();
        await page.keyboard.press("Control+a");
        assert((await page.locator(".et-row.selected").count()) <= 1, "keys inside a window stay in the window (Ctrl+A selects the text, not all entries)");
        await win("Alpha").locator(".form-row", { hasText: "User name:" }).locator("input").press("Escape");
        await win("Alpha").waitFor({ state: "detached" });
        assert((await page.locator(".taskbar").isHidden()), "Esc closes the window, the taskbar disappears with the last window");

        // The size of entry windows is remembered
        await clickRow("Charlie");
        await page.keyboard.press("Enter");
        const charlie = await box(page.locator(".window", { hasText: "Charlie" }).first());
        assert(Math.abs(charlie.width - resized.width) < 4 && Math.abs(charlie.height - resized.height) < 4, "new entry windows get the remembered size");

        // Modal dialogs can be moved too; locking closes all windows
        await page.locator(".menubar-item", { hasText: "Tools" }).click();
        await page.locator(".menu-item", { hasText: "Password generator" }).click();
        await page.locator(".window", { hasText: "Password Generator" }).waitFor();
        assert((await page.locator(".taskbar .task").count()) === 2, "the password generator is a window too");
        await page.keyboard.press("Control+l");
        await page.waitForSelector("text=Your vault is locked");
        assert((await page.locator(".window").count()) === 0, "locking closes all windows");
        await page.fill("input[type=password]", password);
        await page.click("button[type=submit]");
        await page.waitForSelector(".main-view");

        console.log("\n--- Options ---");
        assert(await page.locator(".tree-row.selected", { hasText: "Servers" }).count() === 1, "the folder used last is selected after unlocking");
        await menu("Tools", "Options");
        const options = page.locator(".options-modal");
        const otitle = await box(options.locator(".modal-title"));
        await page.mouse.move(otitle.x + 40, otitle.y + otitle.height / 2);
        await page.mouse.down();
        await page.mouse.move(otitle.x + 40 + 120, otitle.y + otitle.height / 2 + 30, { steps: 4 });
        await page.mouse.up();
        assert(Math.abs((await box(options.locator(".modal-title"))).x - (otitle.x + 120)) < 3, "modal dialogs can be moved");
        await options.locator("[data-option=entryWindows]").uncheck();
        await options.locator(".tab", { hasText: "Interface" }).click();
        await options.locator("select[data-option=accent]").selectOption("green");
        await options.locator("select[data-option=fontSize]").selectOption("14");
        await options.locator("select[data-option=density]").selectOption("comfortable");
        await options.locator("select[data-option=toolbar]").selectOption("text");
        await options.locator("[data-option=gridLines]").check();
        await options.locator("[data-option=showPasswordsInList]").check();
        await options.locator("[data-option=colorPasswords]").check();
        await options.locator("[data-option=hideUsernames]").check();
        await options.locator("[data-option=hideNotes]").check();
        await options.locator(".tab", { hasText: "Search" }).click();
        await options.locator("[data-option=searchPasswords]").check();
        await page.screenshot({ path: screenshotPath("41-options") });
        await options.locator("button.primary", { hasText: "OK" }).click();

        const rowHeight = (await box(row("Alpha"))).height;
        assert(rowHeight >= 27, `comfortable rows with a larger font (${rowHeight}px)`);
        assert((await page.locator(".toolbar .tb-label", { hasText: "Sync" }).isVisible()), "toolbar with text");
        const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
        assert(accent === "#107c10", `green accent color (${accent})`);
        const pwCell = row("Alpha").locator(".et-password");
        assert((await pwCell.innerText()) === "alpha-pw-1!" && (await pwCell.locator(".pw-digit").count()) === 1, "passwords shown and colored in the list");
        assert((await row("Alpha").locator(".et-username").innerText()) === "••••••", "user names hidden in the list");
        await row("Alpha").click();
        assert(!(await page.locator(".details-pane").innerText()).includes("Notes of Alpha"), "notes hidden in the details");
        await page.locator(".search").fill("charlie-pw");
        const found = await page.waitForFunction(() => document.querySelectorAll(".et-row").length === 1 && document.querySelector(".et-row").textContent.includes("Charlie"), null, { timeout: 5000 }).then(() => true, () => false);
        assert(found, "search includes passwords");
        await page.locator(".search").fill("");
        await page.locator(".search").press("Escape");
        await row("Alpha").click();
        await page.keyboard.press("Enter");
        await page.locator(".modal-backdrop .editor-modal").waitFor();
        assert((await page.locator(".window").count()) === 0, "without entry windows the editor is a modal dialog again");
        await page.keyboard.press("Escape");
        await page.screenshot({ path: screenshotPath("42-options-applied") });

        await menu("Tools", "Options");
        await page.locator(".options-modal button", { hasText: "Defaults" }).click();
        await page.locator(".options-modal button.primary", { hasText: "OK" }).click();
        assert((await box(row("Alpha"))).height === 21, "defaults restored");
        assert(errors.length === 0, `no browser errors (${errors.join(" | ")})`);
    } finally {
        await browser.close();
    }
}
