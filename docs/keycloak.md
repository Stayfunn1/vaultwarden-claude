# Keycloak: users, groups and organizations

With Keycloak (or another OpenID Connect provider) as the single place where people are managed,
this fork can take over from it:

* **who may use Vaultwarden at all**: members of an access group,
* **who may create organizations**: members of a creation group,
* **organization memberships, roles and groups**: from groups such as `/vaultwarden/Family/admins`,
* **new, disabled and removed users**: with the scheduled directory sync.

The groups are read at every SSO login and token refresh (so changes apply within the access token
lifetime of Keycloak, 5 minutes by default). The optional directory sync also applies them to people who are not
logged in, creates their accounts in advance and disables the accounts of people who left.

Start with the basic SSO setup in [sso-only.md](sso-only.md); this page adds the groups. The settings
are explained in [permissions.md](permissions.md).

## 1. The client

In the Keycloak admin console, realm *home* (use yours), **Clients → Create client**:

* Client type *OpenID Connect*, client ID `vaultwarden`.
* **Client authentication: On** (confidential client), **Standard flow: On**.
  For the directory sync also **Service accounts roles: On**.
* Valid redirect URIs: `https://vault.example.com/identity/connect/oidc-signin`.
* Copy the secret from the *Credentials* tab.

## 2. Send the groups to Vaultwarden

**Clients → vaultwarden → Client scopes → vaultwarden-dedicated → Configure a new mapper → Group Membership**:

| Setting | Value |
|---|---|
| Name | `groups` |
| Token Claim Name | `groups` |
| Full group path | **On** (the organization sync needs the path, e.g. `/vaultwarden/Family/admins`) |
| Add to ID token | On |
| Add to userinfo | On |

Vaultwarden reads the claim from the ID token, or from the userinfo response when the ID token does
not contain it. The leading `/` of the paths does not matter.

Realm roles work too: set `SSO_GROUPS_CLAIM=realm_access.roles` and make sure the *realm roles*
mapper of the `roles` client scope has *Add to ID token* or *Add to userinfo* switched on. Roles have
no path, so the organization sync then needs roles named like `vaultwarden/Family/admins`.

## 3. Groups

An example structure:

```text
/vaultwarden-users            everyone who may use Vaultwarden
/vaultwarden-org-creators     may create organizations
/vaultwarden
    /Family                   member of the organization "Family" (role User)
        /admins               ... as Admin
        /Parents              ... and in the Vaultwarden group "Parents"
    /Team
        /owners               member of "Team" as Owner
        /managers             ... as Manager
```

Group names in Keycloak are case sensitive, the comparisons in Vaultwarden are not.

## 4. Vaultwarden settings

```env
SSO_ENABLED=true
SSO_ONLY=true
SSO_AUTHORITY=https://auth.example.com/realms/home
SSO_CLIENT_ID=vaultwarden
SSO_CLIENT_SECRET=...
SSO_SIGNUPS_MATCH_EMAIL=true

SSO_GROUPS_CLAIM=groups
SSO_ACCESS_GROUPS=vaultwarden-users
SSO_ORG_CREATION_GROUPS=vaultwarden-org-creators
SSO_ORG_SYNC=true
SSO_ORG_SYNC_PREFIX=vaultwarden
ORG_GROUPS_ENABLED=true          # needed for the Vaultwarden groups (e.g. "Parents")

# Directory sync every 15 minutes (cron with seconds)
SSO_DIRECTORY_SYNC_SCHEDULE=0 */15 * * * *
```

All of them can also be changed on the admin page (*Settings → SSO settings*), except that a new
directory sync schedule needs a restart.

## 5. Organizations

The organization sync manages memberships, it does not create organizations: the organization key is
made in the browser of its owner, the server never knows it. So:

1. Someone in `vaultwarden-org-creators` creates the organization **with exactly the name used in
   Keycloak** (e.g. `Family`), in the web manager (*Organizations → New organization…*) or the web vault.
2. From then on the members of `/vaultwarden/Family` are added at their next login or the next directory
   sync, with the role of their sub group (`owners`, `admins`, `managers`, otherwise *User*) and in the
   Vaultwarden groups named after their other sub groups.
3. New members still have to be **confirmed** once by an owner or admin: this hands them the
   organization key, encrypted for them, which only a client can do. The web manager shows a notice
   in its status bar when members wait for confirmation; *Confirm* in *Organizations → Family…* does it.
4. Give the Vaultwarden groups access to collections (*Collections* tab, or *Collection access…* in the
   context menu of a collection). Owners and admins see all collections anyway.

Rules of the sync:

* Only memberships and groups created or adopted by the sync are changed. It adopts existing
  memberships with the same organization, except owners and revoked members managed by hand.
  Memberships and groups it manages are marked *synced* in the web manager.
* People removed from the group are **revoked**, not deleted: their membership (and the confirmation)
  stays and comes back when they are added again.
* The last confirmed owner of an organization is never changed or revoked.
* Changes made by hand to a synced membership are overwritten at the next login or sync.

## 6. Directory sync

Without it, Vaultwarden only learns about a person when they log in. The directory sync reads all users
and their groups with the Keycloak admin API, using the service account of the `vaultwarden` client:

1. **Clients → vaultwarden → Service accounts roles → Assign role → Filter by clients**, assign
   `realm-management` **view-users** (it includes query-users and query-groups).
2. Set `SSO_DIRECTORY_SYNC_SCHEDULE`, or run it from the admin page (*Users → Sync with Keycloak now*).
   The admin API address is derived from `SSO_AUTHORITY`
   (`https://auth.example.com/realms/home` → `https://auth.example.com/admin/realms/home`); set
   `SSO_DIRECTORY_SYNC_URL` if Keycloak is reached differently.

What it does for every Keycloak user with an e-mail address:

| Situation | Result |
|---|---|
| New user with access (in the access group, or no access groups set) | An account is created and linked to the Keycloak user (`SSO_DIRECTORY_SYNC_CREATE_USERS`), so the organization sync can add it right away. The person chooses a master password at the first SSO login (also possible in the web manager). |
| Existing account with the same, verified, e-mail address | Linked like at an SSO login (needs `SSO_SIGNUPS_MATCH_EMAIL=true` for accounts that are already in use) |
| Groups changed | Stored, the access rules and the organization sync apply them |
| Disabled in Keycloak, or deleted | The account is disabled and all its sessions end (`SSO_DIRECTORY_SYNC_DISABLE_USERS`). It is enabled again when the user returns. Accounts disabled by an administrator stay disabled. |
| Removed from the access group | Logins and token refreshes are refused |

Safety: when Keycloak returns no users at all or an error (for example a missing role), nothing is
changed and the error is shown on the admin page and in the log. Accounts that are not linked to this
Keycloak realm are never touched.

## Other identity providers

Everything except the directory sync works with any OpenID Connect provider that can put the groups or
roles of a user into the ID token or the userinfo response, for example Authentik (*groups* scope),
Zitadel (roles, `SSO_GROUPS_CLAIM` with the claim path) or Microsoft Entra ID (*groups claim*, which
contains group IDs instead of names). Nested claims are written with dots, e.g. `realm_access.roles`.

## Checking it

* Admin page → *Users*: every user shows the groups received at the last login or sync, whether they
  may create organizations, and badges for *No access* and *Disabled in Keycloak*.
* `LOG_LEVEL=info` logs every change of the organization and directory sync; `SSO_DEBUG_TOKENS=true`
  (only temporarily) logs the tokens, including the groups claim.
