# The admin page

`https://vault.example.com/admin` is the server administration of Vaultwarden: users (invite, disable,
delete, permissions, groups of the identity provider), organizations, all settings, diagnostics and
backups. It is separate from the vaults: logging in there gives no access to anyone's passwords (they
stay encrypted), and the vault logins (master password or SSO) do not open it.

## How you log in

The admin page has one shared secret, the **admin token**. You set it on the server, then open `/admin`
and type it into the login form. After that a session cookie keeps you logged in for 20 minutes
(`ADMIN_SESSION_LIFETIME`, in minutes).

| `ADMIN_TOKEN` | Result |
|---|---|
| not set | The admin page is switched off: `/admin` answers *"The admin panel is disabled"*. The safest choice when you do not need it. |
| an Argon2 hash (`$argon2id$...`) | **Recommended.** You log in with the password you hashed, not with the hash. Nobody who reads the configuration can log in with it. |
| plain text | Works, but anyone who can read the environment or `config.json` can log in. Vaultwarden warns about it at startup. |

### Setting it up

1. Choose a long password (a password manager entry works well) and create its hash. The command asks
   for the password twice:

   ```sh
   docker run --rm -it vaultwarden-keepass /vaultwarden hash
   # or, with the container running:
   docker exec -it vaultwarden /vaultwarden hash
   ```

   It prints `ADMIN_TOKEN='$argon2id$v=19$m=65540,t=3,p=4$...'`.
2. Put the value (without the quotes) in `docker-compose.yml`. Docker Compose treats `$` as the start
   of a variable, so **write every `$` twice**:

   ```yaml
       environment:
         ADMIN_TOKEN: "$$argon2id$$v=19$$m=65540,t=3,p=4$$..."
   ```

   (In an `.env` file read by Vaultwarden itself, or with `docker run -e`, use single `$` in single quotes.)
3. `docker compose up -d`, open `https://vault.example.com/admin`, enter the **password** from step 1.

Wrong tokens are rate limited: 3 attempts, then one every 5 minutes (`ADMIN_RATELIMIT_MAX_BURST`,
`ADMIN_RATELIMIT_SECONDS`), per IP address.

## Settings on the admin page win over the environment

When you click **Save** under *Settings*, all editable settings are written to `config.json` in the data
folder (`./vw-data/config.json`), and from then on these values are used **instead of** the environment
variables in `docker-compose.yml`. That includes the admin token itself. So if a change in
`docker-compose.yml` seems to have no effect, it was probably saved on the admin page before:

* change it on the admin page instead, or
* use *Settings → Reset defaults* (deletes `config.json`, the environment applies again), or
* edit or delete `vw-data/config.json` while the container is stopped.

The *Users* page of this fork changes `ORG_CREATION_USERS` the same way.

## Protecting it

The admin page is not affected by `SSO_ONLY`; it only knows the admin token. Recommendations:

* Leave `ADMIN_TOKEN` unset when you do not need the page, set it only for maintenance.
* Or restrict `/admin` in the reverse proxy, for example to your home network. With Caddy:

  ```text
  vault.example.com {
      @admin {
          path /admin*
          not remote_ip 192.168.0.0/16 10.0.0.0/8
      }
      respond @admin 403
      reverse_proxy vaultwarden:80
  }
  ```

* Or put it behind your identity provider in the reverse proxy (e.g. oauth2-proxy or Authelia in front
  of `/admin*`). Only then `DISABLE_ADMIN_TOKEN=true` is acceptable, which removes the token check
  completely: without such a proxy, everybody could open the admin page.

## What you do there in this fork

* *Users*: the **Permissions** panel (who may use Vaultwarden, who may create organizations, Keycloak
  sync status and *Sync with Keycloak now*), and per user the organization creation permission, the
  identity provider groups and badges like *Disabled in Keycloak*. See [permissions.md](permissions.md).
* *Settings → SSO settings*: the identity provider, access groups, organization sync and directory sync.
  See [keycloak.md](keycloak.md).
* Everything else is standard Vaultwarden:
  <https://github.com/dani-garcia/vaultwarden/wiki/Enabling-admin-page>.
