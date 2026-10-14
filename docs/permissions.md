# Permissions

Who may do what, and where to set it. Everything on this page can be combined; groups of an identity
provider are optional (see [keycloak.md](keycloak.md)).

## Who may use Vaultwarden

| How | Where |
|---|---|
| Only logins through your identity provider, no master password logins | `SSO_ONLY=true`, see [sso-only.md](sso-only.md) |
| Only members of certain identity provider groups | `SSO_ACCESS_GROUPS=vaultwarden-users` (comma separated) |
| Single people | Admin page → *Users* → *Disable User* / *Enable User* |
| People disabled in or removed from Keycloak | Directory sync, see [keycloak.md](keycloak.md#6-directory-sync) |
| Who can create an account at all | `SIGNUPS_ALLOWED`, `SSO_SIGNUPS_ALLOWED`, `SIGNUPS_DOMAINS_WHITELIST`, invitations |

With `SSO_ACCESS_GROUPS`, the groups are checked at every SSO login and every token refresh. People
outside the groups are refused, and their existing sessions end at the next token refresh (SSO sessions
refresh with the access token lifetime of the identity provider, e.g. 5 minutes in Keycloak; password
sessions after 2 hours). Accounts that logged in with SSO before are also refused when they try a
password or API key login, so leaving the group closes every door.

## Who may create organizations

Admin page → *Users* → *Permissions* → **Who can create organizations**:

* **Everyone** (the default).
* **Only the users allowed below**: then use *Allow creating organizations* / *Disallow creating
  organizations* in the *Permissions* column of each user.

This edits `ORG_CREATION_USERS` (`all`, `none` or a list of e-mail addresses), which can also be set in
the environment. With `SSO_ORG_CREATION_GROUPS` the members of these identity provider groups may create
organizations as well; "everyone" then no longer applies, only the listed users and the group members.

The person who creates an organization becomes its owner.

## Managing an organization

Inside an organization the roles of Bitwarden apply:

| Role | Can |
|---|---|
| Owner | everything, incl. other owners, policies and deleting the organization |
| Admin | members, groups, all collections and items; not owners |
| Manager | the collections assigned to them with *Can manage* |
| User | the items of the collections assigned to them (directly or through a group) |

Members are managed in the web manager (*Organizations → <name>…*: invite, confirm, role, revoke,
remove, groups, collection access) or in the Admin Console of the Bitwarden web vault. With
`SSO_ORG_SYNC=true` the memberships follow identity provider groups instead, see
[keycloak.md](keycloak.md#5-organizations).

Server administrators can change roles too: admin page → *Users* → click an organization badge.

## Overview of the settings

| Setting | Default | |
|---|---|---|
| `SSO_ONLY` | `false` | Only SSO logins |
| `SSO_ONLY_ALLOW_API_KEY` | `true` | Allow the personal API key while `SSO_ONLY` is active |
| `SSO_GROUPS_CLAIM` | `groups` | Claim with the groups or roles, nested claims with dots (`realm_access.roles`) |
| `SSO_ACCESS_GROUPS` | | Only these groups may use Vaultwarden |
| `ORG_CREATION_USERS` | (everyone) | `all`, `none` or e-mail addresses |
| `SSO_ORG_CREATION_GROUPS` | | These groups may create organizations |
| `SSO_ORG_SYNC` | `false` | Memberships from groups `<prefix>/<organization>[/owners\|admins\|managers\|<group>]` |
| `SSO_ORG_SYNC_PREFIX` | `vaultwarden` | First part of these group names |
| `SSO_DIRECTORY_SYNC_SCHEDULE` | | Cron schedule of the Keycloak directory sync |
| `SSO_DIRECTORY_SYNC_URL` | (derived) | Keycloak admin API of the realm |
| `SSO_DIRECTORY_SYNC_CREATE_USERS` | `true` | Create accounts for new Keycloak users |
| `SSO_DIRECTORY_SYNC_DISABLE_USERS` | `true` | Disable accounts of disabled or removed Keycloak users |
| `ORG_GROUPS_ENABLED` | `false` | Groups inside organizations |
