// Keycloak directory sync: accounts and groups from the Keycloak admin API, disabling of removed users
import { register, login, createOrg, setPassword, ssoToken, refreshToken, adminSession, assert } from "../lib/helpers.mjs";
import { startServer, SSO_PORT, OIDC_PORT } from "../lib/env.mjs";
import { startMockOidc } from "../lib/mock-oidc.mjs";

const password = "directory sync master password";
const ADMIN_TOKEN = "directory-sync-admin-token";

export async function run() {
    const idp = await startMockOidc(OIDC_PORT, { realm: "test" });
    const env = {
        SSO_ENABLED: "true",
        SSO_AUTHORITY: idp.issuer,
        SSO_CLIENT_ID: "vaultwarden",
        SSO_CLIENT_SECRET: "secret",
        SSO_SIGNUPS_MATCH_EMAIL: "true",
        SSO_ACCESS_GROUPS: "vw-users",
        SSO_ORG_SYNC: "true",
        ORG_GROUPS_ENABLED: "true",
        ADMIN_TOKEN,
    };
    let server = await startServer({ port: SSO_PORT, name: "sso-directory", fresh: true, env });
    let base = server.base;
    const kc = (name, extra = {}) => ({ id: `kc-${name}`, username: name, email: `${name}@example.com`, firstName: name, lastName: "Test", groups: ["/vw-users"], ...extra });

    try {
        const admin = await adminSession(base, ADMIN_TOKEN);
        const sync = () => admin("POST", "/sso/directory-sync");
        const account = async (name) => {
            const r = await admin("GET", `/users/by-mail/${name}@example.com`);
            return r.status === 200 ? r.body : null;
        };

        // alice registered before SSO, owns the organization Family; hank registered too, but his address is not verified in Keycloak
        const alice = await register(base, "alice@example.com", password);
        const a = await login(base, "alice@example.com", password);
        const orgId = await createOrg(a.vault, "Family", alice.publicKey);
        await register(base, "hank@example.com", password);
        const member = async (email) => (await a.api.get(`/api/organizations/${orgId}/users`)).data.find((m) => m.email === email);

        const noEmail = Array.from({ length: 201 }, (_, i) => ({ id: `kc-service-${i}`, username: `service-${i}`, groups: [] }));
        const directory = {
            alice: kc("alice", { groups: ["/vw-users", "/vaultwarden/Family/owners"] }),
            erin: kc("erin", { groups: ["/vw-users", "/vaultwarden/Family"] }),
            frank: kc("frank", { groups: [] }),
            gina: kc("gina", { enabled: false }),
            hank: kc("hank", { emailVerified: false }),
        };
        const publish = () => idp.setDirectory([...noEmail, ...Object.values(directory)]);
        publish();

        console.log("\n--- First sync ---");
        let r = await sync();
        assert(r.status === 200, `sync ran (${JSON.stringify(r.body).slice(0, 200)})`);
        assert(idp.adminRequests.some((p) => p.startsWith("/admin/realms/test/users?first=200")), "users read page by page (admin API derived from the issuer)");
        assert(r.body.users === 5, "5 Keycloak users with an e-mail address");
        assert(r.body.created === 1 && r.body.linked === 1, "erin created, alice linked");
        assert(r.body.skipped.some((s) => s.startsWith("hank@example.com")), "hank skipped (address not verified)");
        assert(!(await account("frank")) && !(await account("gina")), "no accounts for users without access or disabled in Keycloak");
        const erin = await account("erin");
        assert(erin && erin.userEnabled && erin.name === "erin Test", "account created for erin, with the Keycloak name");
        assert((await member("erin@example.com"))?.status === 0, "erin invited to Family by the organization sync");
        assert((await member("alice@example.com")).type === 0, "alice stays owner");

        console.log("\n--- Login of a provisioned user ---");
        idp.setUser({ sub: "kc-erin", email: "erin@example.com", groups: directory.erin.groups });
        const erinLogin = await ssoToken(base);
        assert(erinLogin.status === 200, "erin logs in with SSO into the provisioned account");
        assert((await account("erin")).id === erin.id, "no second account");
        await setPassword(base, erinLogin.body.access_token, "erin@example.com", password);
        assert((await member("erin@example.com")).status === 1, "erin accepted in Family after setting the master password");

        console.log("\n--- Disabled and removed users ---");
        directory.erin.enabled = false;
        publish();
        r = await sync();
        assert(r.body.disabled === 1 && !(await account("erin")).userEnabled, "erin disabled in Keycloak: account disabled");
        assert((await refreshToken(base, erinLogin.body.refresh_token)).status !== 200, "erin's sessions ended");
        assert((await ssoToken(base)).status !== 200, "erin can not log in");
        directory.erin.enabled = true;
        publish();
        r = await sync();
        assert(r.body.enabled === 1 && (await account("erin")).userEnabled, "erin enabled in Keycloak again: account enabled");
        assert((await ssoToken(base)).status === 200, "erin can log in again");

        const aliceAccount = await account("alice");
        await admin("POST", `/users/${aliceAccount.id}/disable`);
        await sync();
        assert(!(await account("alice")).userEnabled, "an account disabled by the administrator stays disabled");
        await admin("POST", `/users/${aliceAccount.id}/enable`);

        delete directory.erin;
        publish();
        r = await sync();
        assert(r.body.disabled === 1 && !(await account("erin")).userEnabled, "erin removed from Keycloak: account disabled");
        assert((await account("hank")).userEnabled, "accounts not linked to Keycloak are not touched");

        directory.frank.groups = ["/vw-users"];
        publish();
        r = await sync();
        assert(r.body.created === 1 && (await account("frank")), "frank added to the access group: account created");

        console.log("\n--- Failures change nothing ---");
        idp.setAdminStatus(403);
        r = await sync();
        assert(r.status === 400 && JSON.stringify(r.body).includes("403"), "missing permission of the service account reported");
        idp.setAdminStatus(200);
        idp.setDirectory([]);
        r = await sync();
        assert(r.status === 400 && JSON.stringify(r.body).includes("returned no users"), "empty user list refused");
        assert((await account("frank")).userEnabled && (await account("alice")).userEnabled, "nobody disabled");
        const status = await admin("GET", "/sso/directory-sync");
        assert(status.body.lastRun?.error?.includes("returned no users"), "admin status shows the last error");

        console.log("\n--- Schedule ---");
        publish();
        await server.stop();
        server = await startServer({ port: SSO_PORT, name: "sso-directory", env: { ...env, SSO_DIRECTORY_SYNC_SCHEDULE: "*/2 * * * * *", JOB_POLL_INTERVAL_MS: "500" } });
        base = server.base;
        const admin2 = await adminSession(base, ADMIN_TOKEN);
        let last = null;
        for (let i = 0; i < 30 && !last; i++) {
            await new Promise((res) => setTimeout(res, 500));
            last = (await admin2("GET", "/sso/directory-sync")).body.lastRun;
        }
        assert(last?.report?.users === 4, "scheduled sync ran");
    } finally {
        await server.stop();
        await idp.stop();
    }
}
