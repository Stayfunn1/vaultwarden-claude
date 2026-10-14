# Web manager tests

End-to-end tests for the web manager (`/manager/`), the KeePass import, the SSO only mode and the
permissions from identity provider groups.
They start temporary Vaultwarden servers (HTTPS with a self-signed certificate) and check the results
with the **official Bitwarden CLI**, which uses the same crypto code as the Bitwarden web vault, browser
extension and desktop app. That is the proof that everything the manager writes stays compatible.

| Suite | What it checks |
|---|---|
| `interop` | Items, custom fields, TOTP, URIs, attachments, history, folder moves and sharing written by the manager decrypt in `bw`, and items written by `bw` decrypt and stay intact when edited in the manager (PBKDF2 and Argon2id accounts) |
| `keepass-import` | `.kdbx` and KeePass XML conversion (groups, protected fields, attachments, TOTP variants, references, history, long notes, standard and custom icons), import into a personal vault and into an organization, re-import skipping existing entries, encrypted icon storage |
| `regressions` | Data safety rules: password history on retried saves, rejected server-injected values, read-only incomplete SSH keys, background sync vs. running operations, all-or-nothing import entries, editing restored items |
| `ui` | The UI in Chromium: folder tree, editor, drag & drop of entries and folder trees, rename, search, trash, lock, KeePass import with icons, changing icons, TOTP two-step login, attachments, sharing by drag & drop |
| `orgs` | Organizations in the manager: create, invite, confirm (key exchange), roles, groups, collection access, revoke, restore, remove; dark mode switch |
| `sso` | SSO login of the manager with a mock OpenID Connect provider, and `SSO_ONLY` refusing password logins, password registration, the password based e-mail 2FA endpoint and (optionally) API key logins |
| `sso-groups` | Groups from the ID token and the userinfo endpoint: `SSO_ACCESS_GROUPS` (SSO, password, API key and refresh), `SSO_ORG_CREATION_GROUPS`, `SSO_ORG_SYNC` (roles, groups, revoke, restore, new accounts) at logins and token refreshes |
| `sso-directory` | Keycloak directory sync against a mock admin API: paging, creating and linking accounts, disabling and enabling, failures that must change nothing, the schedule; first SSO login with setting the master password in the manager; the permissions panel of the admin page |
| `perf` | Not run by default: 5000 entries in 500 folders, timings of import, unlock, listing, search and folder operations |

## Running

Requirements: Node.js 20+, `openssl`, and a built Vaultwarden (`cargo build --features sqlite`).

```sh
cd tools/manager-tests
npm ci
npx playwright install chromium     # or set CHROMIUM_PATH to an existing Chromium
node run.mjs                        # all default suites
node run.mjs ui sso                 # selected suites
node run.mjs perf                   # large vault timings
```

Environment variables:

* `VW_BIN`: the Vaultwarden binary (default `../../target/debug/vaultwarden`). The manager files are
  embedded in the binary, so rebuild after changing them.
* `CHROMIUM_PATH`: Chromium executable, if not the one installed by Playwright.
* `VWM_TEST_PORT` (default 8400, the SSO suites use +10 and the regressions suite +5) and
  `VWM_TEST_OIDC_PORT` (default 9400).

Server logs and screenshots are written to a temporary work directory, printed at the start and end.
