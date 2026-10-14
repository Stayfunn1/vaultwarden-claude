# Installing this fork

This guide sets up this Vaultwarden fork with Docker Compose behind an HTTPS reverse proxy, moves your
KeePass database into it and connects the Bitwarden apps. It ends with optional steps for SSO only
login and for sharing with groups.

There is no prebuilt image of this fork, you build it yourself from this repository (one command).
The image contains everything: Vaultwarden, the official Bitwarden web vault and the web manager.

## What you need

* A Linux server (x86-64 or ARM64) with [Docker and the Compose plugin](https://docs.docker.com/engine/install/).
* A domain name pointing to the server, e.g. `vault.example.com`, with ports 80 and 443 reachable
  (for the automatic Let's Encrypt certificate).
  **HTTPS is required**: the Bitwarden apps refuse plain HTTP, and browsers only allow the cryptography
  the web vault and the manager need on secure pages.
* For building: about 4 GB of RAM and 10 to 30 minutes, it compiles Vaultwarden from source.

## 1. Build the image

```sh
git clone https://github.com/Stayfunn1/vaultwarden-claude.git
cd vaultwarden-claude
# until the pull request is merged: git checkout claude/ecstatic-franklin-vtwh8z
docker build -t vaultwarden-keepass .
```

The image is built for the architecture of the machine you run this on. To build on a fast x86 machine
for an ARM64 server (e.g. a Raspberry Pi 4/5), see [docker/README.md](../docker/README.md) for the QEMU
setup, then:

```sh
docker buildx build --platform linux/arm64 -t vaultwarden-keepass --load .
docker save vaultwarden-keepass | ssh user@server docker load
```

## 2. Configure

Create a folder on the server, e.g. `/opt/vaultwarden`, with these two files.

`docker-compose.yml`:

```yaml
services:
  vaultwarden:
    image: vaultwarden-keepass
    container_name: vaultwarden
    restart: unless-stopped
    environment:
      DOMAIN: "https://vault.example.com"
      # Allow creating your account, set to "false" afterwards (step 3)
      SIGNUPS_ALLOWED: "true"
      # Groups for organizations (beta upstream, see docs/sharing.md)
      ORG_GROUPS_ENABLED: "true"
      # Admin page at /admin: put the Argon2 hash from step 2b here, or leave it out to disable the page.
      # In this file every "$" of the hash must be written as "$$".
      # ADMIN_TOKEN: "$$argon2id$$v=19$$m=65540,t=3,p=4$$..."
    volumes:
      - ./vw-data:/data

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy-data:/data
      - ./caddy-config:/config
```

`Caddyfile` (Caddy gets and renews the certificate on its own):

```
vault.example.com {
    encode zstd gzip
    reverse_proxy vaultwarden:80
}
```

Already running nginx, Traefik or another proxy? Point it to the container's port 80 instead, and allow
large uploads for attachments (nginx: `client_max_body_size 525m;`).

### 2b. Admin page (optional)

The admin page (`https://vault.example.com/admin`) manages users, organizations and settings. Protect it
with a hashed token, generate one with:

```sh
docker run --rm -it vaultwarden-keepass /vaultwarden hash
```

and put the printed `$argon2id$...` value in `ADMIN_TOKEN` (with every `$` doubled, see above).

All settings are documented in [.env.template](../.env.template). The ones added by this fork:
`WEB_MANAGER_ENABLED` (default `true`) and `SSO_ONLY_ALLOW_API_KEY`.

## 3. Start and create your account

```sh
cd /opt/vaultwarden
docker compose up -d
docker compose logs -f vaultwarden    # Ctrl+C to stop following the log
```

1. Open `https://vault.example.com`, click **Create account** and choose a strong master password.
   It encrypts your vault and can not be recovered by anyone, not even the server admin.
2. Set `SIGNUPS_ALLOWED: "false"` in `docker-compose.yml` and run `docker compose up -d` again.
   Other people can still be invited from the admin page or from an organization.
3. Turn on two-step login: web vault → **Settings → Security → Two-step login** (an authenticator
   app or a security key). With SSO only (step 6) enforce MFA in your identity provider instead.

## 4. Import your KeePass database

Before a big import, make a backup of the empty vault so you can start over easily:
`docker compose stop vaultwarden && cp -a vw-data vw-data.before-import && docker compose start vaultwarden`.

1. Open the web manager: `https://vault.example.com/manager/` and log in.
2. **File → Import KeePass database…**, choose your `.kdbx` file, enter its password (and key file).
3. Check the summary, optionally enter a parent folder like `KeePass`, and click **Import**.

Details about what is imported, and about databases that use Twofish, are in
[web-manager.md](web-manager.md#migrating-from-keepass). From now on you can manage your folders in the
manager (drag & drop, rename whole trees), or use any Bitwarden app.

## 5. Connect the Bitwarden apps

Install the [Bitwarden apps](https://bitwarden.com/download/) (browser extension, desktop, iOS, Android).
On the login screen open the server selection ("Logging in on: bitwarden.com"), choose **self-hosted**
and enter `https://vault.example.com` as the server URL, then log in with your e-mail address and master
password. Your custom fields are copyable in the item view of every app.

## 6. Optional: SSO only

1. Create an OpenID Connect client in your identity provider (Keycloak, Authentik, Authelia, Zitadel,
   Entra ID, ...) with redirect URI `https://vault.example.com/identity/connect/oidc-signin`.
2. Add to the `environment` of the `vaultwarden` service:

   ```yaml
      SSO_ENABLED: "true"
      SSO_ONLY: "true"
      SSO_AUTHORITY: "https://auth.example.com/realms/home"
      SSO_CLIENT_ID: "vaultwarden"
      SSO_CLIENT_SECRET: "..."
      SSO_SIGNUPS_MATCH_EMAIL: "true"
   ```

3. `docker compose up -d`. Your existing account is linked by its e-mail address the first time you log
   in with SSO (the identity provider must report the address as verified). In the apps choose
   **Use single sign-on**, then unlock with your master password.

Everything SSO only blocks, and why the master password stays, is explained in [sso-only.md](sso-only.md).

## 7. Optional: sharing with family or a team

Create an organization in the web vault, invite people, create groups and collections, and move items
into collections, for example by dragging them onto a collection in the manager. See
[sharing.md](sharing.md).

## Backups

Everything lives in `./vw-data`: the database (`db.sqlite3`), attachments, the `rsa_key*` files and
`config.json`. A consistent backup:

```sh
docker exec vaultwarden /vaultwarden backup   # writes a copy of the database into vw-data
tar czf vaultwarden-$(date +%F).tar.gz -C /opt/vaultwarden vw-data
```

Store backups somewhere else. The vault data in them stays encrypted with your master password.
More options: <https://github.com/dani-garcia/vaultwarden/wiki/Backing-up-your-vault>.

## Updating

```sh
cd vaultwarden-claude && git pull && docker build -t vaultwarden-keepass .
cd /opt/vaultwarden && docker compose up -d
```

To get new upstream Vaultwarden releases into the fork:

```sh
git remote add upstream https://github.com/dani-garcia/vaultwarden.git   # once
git fetch upstream && git merge upstream/main && git push
```

## Coming from an existing Vaultwarden installation

This fork uses the same data folder and database as Vaultwarden and adds no database changes. Stop the
old container, back up its data folder, use that folder as `./vw-data` (or keep your existing volume
path) with the `vaultwarden-keepass` image, and start it again. Going back to the official image works
the same way, with an official version at least as new as this fork's base.

## Without Docker

Build with `cargo build --release --features sqlite` (needs the Rust toolchain from
`rust-toolchain.toml`), download a web vault build from
[bw_web_builds](https://github.com/dani-garcia/bw_web_builds/releases) into `web-vault/` next to the binary,
copy `.env.template` to `.env` and adjust it, then run `target/release/vaultwarden`. The manager is
compiled into the binary. HTTPS still has to come from a reverse proxy.
