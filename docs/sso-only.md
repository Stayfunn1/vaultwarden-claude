# SSO only (OpenID Connect)

Vaultwarden can require every login to go through your identity provider (Keycloak, Authentik,
Authelia, Zitadel, Microsoft Entra ID, Google, ...) via OpenID Connect. This fork closes the remaining
ways to use a master password against the server when that mode is on, so nobody can enter an
e-mail address and keep guessing master passwords.

Upstream documentation for the SSO feature itself (provider specific settings, troubleshooting):
<https://github.com/dani-garcia/vaultwarden/wiki/Enabling-SSO-support-using-OpenId-Connect>

## Setup

1. Create an OpenID Connect client in your identity provider:
   * client type *confidential*, authorization code flow (PKCE is used)
   * redirect URI: `https://<your-domain>/identity/connect/oidc-signin`
   * scopes: `openid email profile` (+ `offline_access` if your provider needs it to issue refresh tokens)
   * make sure the provider returns a **verified** e-mail address
   * enforce multi-factor authentication in the identity provider
2. Configure Vaultwarden, for example:

   ```env
   DOMAIN=https://vault.example.com
   SSO_ENABLED=true
   SSO_ONLY=true
   SSO_AUTHORITY=https://auth.example.com/realms/home   # without /.well-known/openid-configuration
   SSO_CLIENT_ID=vaultwarden
   SSO_CLIENT_SECRET=...
   SSO_SIGNUPS_MATCH_EMAIL=true      # link existing accounts by their (verified) e-mail address
   # SSO_SIGNUPS_ALLOWED=false       # only allow existing/invited users
   # SSO_ONLY_ALLOW_API_KEY=false    # also refuse the personal API key (Bitwarden CLI)
   ```

3. Migrating existing accounts: if you already have an account with a master password, either log in
   once with SSO while `SSO_ONLY=false` (it gets linked by e-mail address), or switch directly to
   `SSO_ONLY=true` with `SSO_SIGNUPS_MATCH_EMAIL=true`. Your vault and master password stay the same.

## Logging in

* Bitwarden apps and browser extension: set the server URL to your domain (self-hosted), then choose
  **Use single sign-on** (the organization identifier is filled in automatically, any value works),
  log in at your identity provider, and unlock the vault with your master password.
* Web manager: `https://<your-domain>/manager/` shows only the SSO button when `SSO_ONLY=true`.
* Bitwarden CLI: `bw login --sso`, or `bw login --apikey` if `SSO_ONLY_ALLOW_API_KEY=true`.

## What `SSO_ONLY=true` blocks

| Path | Without SSO only | With SSO only |
|---|---|---|
| E-mail + master password login (`grant_type=password`), incl. "log in with device" | allowed | refused, same answer for right and wrong passwords |
| Unauthenticated e-mail 2FA code request with a master password hash | allowed | refused *(added in this fork)* |
| Registering an account with a master password (also via invitations) | allowed | refused, accounts are created by logging in with SSO *(added in this fork)* |
| Refreshing sessions that were created with a password | allowed | refused, the user has to log in with SSO |
| Personal API key login (`bw login --apikey`) | allowed | allowed by default, refused with `SSO_ONLY_ALLOW_API_KEY=false` *(added in this fork)* |
| Organization API key (Directory Connector) | allowed | allowed (not a user login) |

## Why there is still a master password

Bitwarden is end-to-end encrypted: the vault is encrypted with a key that is derived from your master
password, in your browser or app. The identity provider proves *who you are* to the server, but it
can not decrypt your vault; the master password does that, locally. With SSO only, the master password
is never used to log in to the server anymore, so it can not be guessed online: an attacker first has
to pass your identity provider (with its MFA), and even then the server never verifies the master
password, it only hands out encrypted data.

Recommendations:

* Enforce MFA in the identity provider, it is now the gate to the server.
* Keep a strong master password; it protects the encrypted data (also in backups).
* Protect or disable the admin page: use an Argon2 hashed `ADMIN_TOKEN`, or leave it unset to
  disable the page. It is not a user login and not affected by `SSO_ONLY`.
* By default the Vaultwarden session follows the identity provider session: when the provider stops
  refreshing tokens, the user has to log in again. Use `SSO_AUTH_ONLY_NOT_SESSION=true` to only use SSO
  for the login itself.
