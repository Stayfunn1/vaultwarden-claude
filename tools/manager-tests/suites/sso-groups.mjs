// Identity provider groups: access to Vaultwarden (SSO_ACCESS_GROUPS), organization creation (SSO_ORG_CREATION_GROUPS)
// and organization memberships (SSO_ORG_SYNC), at SSO logins and token refreshes
import { register, login, createOrg, setPassword, ssoToken, refreshToken, assert } from "../lib/helpers.mjs";
import { startServer, SSO_PORT, OIDC_PORT } from "../lib/env.mjs";
import { startMockOidc } from "../lib/mock-oidc.mjs";

const password = "group sync master password";
const MemberStatus = { Revoked: -1, Invited: 0, Accepted: 1, Confirmed: 2 };
// Managers are shown as custom role (4) to the clients
const MemberType = { Owner: 0, Admin: 1, User: 2, Manager: 4 };

export async function run() {
    const idp = await startMockOidc(OIDC_PORT);
    const server = await startServer({
        port: SSO_PORT,
        name: "sso-groups",
        fresh: true,
        env: {
            SSO_ENABLED: "true",
            SSO_AUTHORITY: idp.issuer,
            SSO_CLIENT_ID: "vaultwarden",
            SSO_CLIENT_SECRET: "secret",
            SSO_SIGNUPS_MATCH_EMAIL: "true",
            SSO_ONLY: "false",
            SSO_ACCESS_GROUPS: "vw-users",
            SSO_ORG_CREATION_GROUPS: "vw-org-creators",
            SSO_ORG_SYNC: "true",
            ORG_GROUPS_ENABLED: "true",
        },
    });
    const base = server.base;
    const as = (name, groups, groupsIn) => idp.setUser({ sub: `sub-${name}`, email: `${name}@example.com`, groups, groupsIn });
    const failure = (promise) => promise.then(() => "", (e) => e.message);

    try {
        console.log("\n--- Organization creation ---");
        const alice = await register(base, "alice@example.com", password);
        as("alice", ["/vw-users", "/vw-org-creators"]);
        assert((await ssoToken(base)).status === 200, "SSO login of a member of the access group");
        const a = await login(base, "alice@example.com", password);
        const orgId = await createOrg(a.vault, "Family", alice.publicKey);
        assert(!!orgId, "member of SSO_ORG_CREATION_GROUPS creates an organization");
        const members = async () => (await a.api.get(`/api/organizations/${orgId}/users?includeGroups=true`)).data;
        const member = async (email) => (await members()).find((m) => m.email === email);

        const bob = await register(base, "bob@example.com", password);
        as("bob", ["vw-users"], "userinfo");
        let bobSso = await ssoToken(base);
        assert(bobSso.status === 200, "groups read from the userinfo endpoint");
        const b = await login(base, "bob@example.com", password);
        const bobPasswordRefresh = b.api.tokens.refresh_token;
        const refused = await failure(createOrg(b.vault, "Bob's", bob.publicKey));
        assert(refused.includes("not allowed to create organizations"), "user outside SSO_ORG_CREATION_GROUPS can not create organizations");

        console.log("\n--- Organization sync ---");
        as("bob", ["vw-users", "vaultwarden/Family", "vaultwarden/Family/admins", "vaultwarden/Family/Parents", "vaultwarden/Unknown"]);
        bobSso = await ssoToken(base);
        let m = await member("bob@example.com");
        assert(m?.type === MemberType.Admin && m.status === MemberStatus.Accepted, "bob added to Family as admin, waiting for confirmation");
        const parents = (await a.api.get(`/api/organizations/${orgId}/groups`)).data.find((g) => g.name === "Parents");
        assert(!!parents, "group Parents created");
        assert(m.groups.includes(parents.id), "bob is a member of the group Parents");

        as("bob", ["vw-users", "vaultwarden/Family"]);
        assert((await refreshToken(base, bobSso.body.refresh_token)).status === 200, "SSO token refresh");
        m = await member("bob@example.com");
        assert(m.type === MemberType.User, "group change applied at the token refresh: bob is now a user");
        assert(!m.groups.includes(parents.id), "bob removed from the synced group Parents");

        as("bob", ["vw-users"]);
        await ssoToken(base);
        m = await member("bob@example.com");
        assert(m?.status === MemberStatus.Revoked, "bob revoked when removed from the organization group");

        as("bob", ["vw-users", "VaultWarden/family/managers"]);
        bobSso = await ssoToken(base);
        m = await member("bob@example.com");
        assert(m.status === MemberStatus.Accepted && m.type === MemberType.Manager, "bob restored as manager (names are case insensitive)");

        as("alice", ["vw-users", "vw-org-creators"]);
        await ssoToken(base);
        m = await member("alice@example.com");
        assert(m.type === MemberType.Owner && m.status === MemberStatus.Confirmed, "membership managed by hand is not touched by the sync");

        console.log("\n--- New SSO user ---");
        as("dave", ["vw-users", "vaultwarden/Family"]);
        const dave = await ssoToken(base);
        assert(dave.status === 200, "SSO login creates the account");
        m = await member("dave@example.com");
        assert(m?.status === MemberStatus.Invited, "dave invited to Family before the account has keys");
        await setPassword(base, dave.body.access_token, "dave@example.com", password);
        assert((await member("dave@example.com")).status === MemberStatus.Accepted, "invitation accepted when the master password is set");

        console.log("\n--- Access ---");
        as("carol");
        const carol = await ssoToken(base);
        assert(carol.status === 400 && JSON.stringify(carol.body).includes("did not send the groups"), "login refused without a groups claim");

        as("bob", ["other"]);
        const denied = await ssoToken(base);
        assert(denied.status === 400 && JSON.stringify(denied.body).includes("not allowed to use this Vaultwarden"), "SSO login refused outside SSO_ACCESS_GROUPS");
        assert((await refreshToken(base, bobSso.body.refresh_token)).status === 400, "SSO session ends at the next refresh");
        const pwDenied = await failure(login(base, "bob@example.com", password));
        assert(pwDenied.includes("not allowed to use this Vaultwarden"), "password login refused too (groups stored at the refused SSO login)");
        assert((await refreshToken(base, bobPasswordRefresh)).status === 400, "password session ends at the next refresh");
        m = await member("bob@example.com");
        assert(m.status === MemberStatus.Revoked, "bob revoked in Family");

        as("bob", ["vw-users"]);
        assert((await ssoToken(base)).status === 200, "access restored when added to the group again");
        assert(!(await failure(login(base, "bob@example.com", password))), "password login allowed again");
    } finally {
        await server.stop();
        await idp.stop();
    }
}
