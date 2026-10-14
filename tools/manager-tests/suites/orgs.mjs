// Organizations in the manager: create, invite, confirm, roles, groups, collection access, revoke and remove
import { register, login, assert, uid, launchBrowser, managerLogin, screenshotPath } from "../lib/helpers.mjs";

export async function run({ base }) {
    const owner = `org-owner-${uid()}@example.com`;
    const member = `org-member-${uid()}@example.com`;
    const password = "organization test master password";
    await register(base, owner, password);
    await register(base, member, password);
    const orgName = `Team ${uid()}`;

    const { browser, page, errors } = await launchBrowser();
    const menu = async (top, item) => {
        await page.locator(".menubar-item", { hasText: top }).click();
        await page.locator(".menu-item", { hasText: item }).first().click();
    };
    const orgDialog = page.locator(".org-modal");
    const memberRow = () => orgDialog.locator(`tr[data-member="${member}"]`);
    try {
        console.log("\n--- Dark mode ---");
        await page.goto(`${base}/manager/`);
        await page.click(".auth-theme");
        assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark mode switched on at the login page");
        const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        assert(background === "rgb(32, 32, 32)", `dark background (${background})`);
        await managerLogin(page, base, owner, password);
        await page.waitForSelector(".main-view", { timeout: 60000 });
        assert((await page.locator(".toolbar .theme-toggle").getAttribute("title")) === "Switch to light mode", "toolbar offers light mode, the choice is remembered");

        console.log("\n--- New organization ---");
        await menu("Organizations", "New organization");
        await page.locator(".modal input").first().fill(orgName);
        await page.locator(".modal button.primary", { hasText: "Create" }).click();
        await page.waitForSelector(`.tree-row:has-text("${orgName}")`, { timeout: 30000 });
        assert(true, "organization created and shown in the tree");
        if (!(await page.locator(".tree-row", { hasText: "Shared" }).count())) await page.locator(".tree-row", { hasText: orgName }).locator(".tree-caret").click();
        await page.waitForSelector('.tree-row:has-text("Shared")', { timeout: 5000 }).catch(() => {});
        assert((await page.locator(".tree-row", { hasText: "Shared" }).count()) === 1, "first collection created");

        console.log("\n--- Members ---");
        await menu("Organizations", orgName);
        await orgDialog.locator("input[placeholder^='E-mail']").fill(member);
        await orgDialog.locator("button", { hasText: "Invite" }).click();
        await memberRow().waitFor();
        assert((await memberRow().locator(".member-status").textContent()) === "Needs confirmation", "existing user invited and accepted (no mail server), waiting for confirmation");
        await page.screenshot({ path: screenshotPath("30-org-members") });
        await orgDialog.locator("button.primary", { hasText: "Close" }).click();
        await page.waitForSelector(".status-notice:not([hidden])");
        assert((await page.locator(".status-notice").textContent()).includes("1 member waiting for confirmation"), "status bar shows the pending confirmation");
        await page.locator(".status-notice").click();
        await memberRow().locator("button", { hasText: "Confirm" }).click();
        await memberRow().locator(".member-status", { hasText: "Confirmed" }).waitFor();
        assert(true, "member confirmed");

        await memberRow().locator("select").selectOption("4");
        await page.waitForTimeout(300);
        await memberRow().locator("select").waitFor();
        const ownerSession = await login(base, owner, password);
        const orgId = [...ownerSession.vault.organizations.values()].find((o) => o.name === orgName).id;
        const remote = async () => (await ownerSession.api.get(`/api/organizations/${orgId}/users?includeGroups=true`)).data.find((m) => m.email === member);
        for (let i = 0; i < 20 && (await remote()).type !== 4; i++) await page.waitForTimeout(250);
        assert((await remote()).type === 4, "role changed to manager");

        console.log("\n--- Groups and collection access ---");
        await orgDialog.locator(".tab", { hasText: "Groups" }).click();
        await orgDialog.locator("button", { hasText: "New group" }).click();
        await page.locator(".modal input[type=text]").last().fill("Editors");
        await page.locator(".modal button.primary", { hasText: "OK" }).last().click();
        const groupRow = orgDialog.locator('tr[data-group="Editors"]');
        await groupRow.waitFor();
        await groupRow.locator("button", { hasText: "Members" }).click();
        await page.locator(".modal label.check", { hasText: member }).locator("input").check();
        await page.locator(".modal button.primary", { hasText: "Save" }).last().click();
        await groupRow.locator("td", { hasText: "org-member" }).waitFor();
        assert(true, "member added to the group");

        await orgDialog.locator(".tab", { hasText: "Collections" }).click();
        await orgDialog.locator('tr[data-collection="Shared"] button', { hasText: "Access" }).click();
        const groupAccess = page.locator('.modal tr[data-access="Group: Editors"]');
        await groupAccess.locator("input[type=checkbox]").check();
        await groupAccess.locator("select").selectOption("view");
        assert((await page.locator('.modal tr[data-access$="(owner or admin)"], .modal tr:has-text("All collections (owner or admin)")').count()) >= 1, "owners shown with access to all collections");
        await page.screenshot({ path: screenshotPath("31-collection-access") });
        await page.locator(".modal button.primary", { hasText: "Save" }).last().click();
        await page.waitForSelector("text=Access saved");

        const m = await login(base, member, password);
        const shared = [...m.vault.collections.values()].find((col) => col.organizationId === orgId && col.path === "Shared");
        assert(shared && shared.readOnly, "the member sees the collection read only through the group");

        console.log("\n--- Revoke, restore, remove ---");
        await orgDialog.locator(".tab", { hasText: "Members" }).click();
        await memberRow().locator("button", { hasText: "Revoke" }).click();
        await page.locator(".modal button.danger", { hasText: "Revoke" }).click();
        await memberRow().locator(".member-status", { hasText: "Revoked" }).waitFor();
        assert(true, "member revoked");
        await memberRow().locator("button", { hasText: "Restore" }).click();
        await memberRow().locator(".member-status", { hasText: "Confirmed" }).waitFor();
        assert(true, "member restored");
        await memberRow().locator("button", { hasText: "Remove" }).click();
        await page.locator(".modal button.danger", { hasText: "Remove" }).click();
        await page.waitForFunction((email) => !document.querySelector(`.org-modal tr[data-member="${email}"]`), member);
        assert(!(await remote()), "member removed");
        await orgDialog.locator("button.primary", { hasText: "Close" }).click();

        console.log("\n--- Tree context menu ---");
        await page.locator(".tree-row", { hasText: "Shared" }).click({ button: "right" });
        await page.locator(".menu-item", { hasText: "Collection access" }).click();
        await page.waitForSelector('.modal tr[data-access="Group: Editors"]');
        assert(await page.locator('.modal tr[data-access="Group: Editors"] input[type=checkbox]').isChecked(), "collection access opened from the tree");
        await page.keyboard.press("Escape");
        await page.locator(".toolbar .theme-toggle").click();
        assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "light", "light mode switched on from the toolbar");
        assert(errors.length === 0, `no browser errors (${errors.join(" | ")})`);
    } finally {
        await browser.close();
    }
}
