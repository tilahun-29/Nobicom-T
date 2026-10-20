# Putting the help desk online

Pick one option. Option A is the easiest. Option B gives you full control on your own server.

You need a web address for the site. A subdomain such as `help.yourcompany.com` works well. You can start with the free address your host gives you and add your own later.

## Deploy beside the main Nobicom site

To serve the help desk at `https://nobicomtech.com/support`, set:

```
PUBLIC_URL=https://nobicomtech.com
BASE_PATH=/support
```

Keep the prefix on the public URL. Start only the app container so this project does not compete with the main site's web server for ports 80/443:

```
docker compose up -d --build app
```

The app is published only on `127.0.0.1:3000`. In the existing Nobicom reverse-proxy configuration, route only `/support` to this app and keep the current website handler as the fallback. For Caddy, add this inside the existing `nobicomtech.com` site block:

```
@helpdesk path /support /support/*
handle @helpdesk {
   reverse_proxy 127.0.0.1:3000
}
```

Set `BASE_PATH=/support` in the app environment. The proxy can preserve `/support`; the app handles both preserved and stripped prefixes and uses the prefix in links, assets, redirects, cookies, and ticket URLs. Do not replace the main site's Caddy configuration with this app's standalone `Caddyfile`.

## Option A: Render (about 15 minutes)

1. Create a free account at https://github.com. Create a **private** repository and upload all files from this folder. Do not upload a file named `.env`.
2. Create an account at https://render.com. Choose **New**, then **Blueprint**, and connect your repository. Render reads `render.yaml` and sets everything up.
3. Render asks for the settings below. Fill them in:
   - `STAFF_USERS`: staff emails and passwords as `name@nobicomtech.com:password`. Emails must use `@nobicomtech.com`; passwords need at least 10 characters.
   - `PUBLIC_URL`: for now the address Render shows for your service, for example `https://nobicom-helpdesk.onrender.com`.
   - `SUPPORT_HOTLINE` and `SUPPORT_EMAIL`: shown on the site.
4. Press deploy and wait until the service shows **Live**. Open the address. Staff sign in at `/staff`.
5. To use your own address, open the service, then **Settings**, then **Custom Domains**, and add `help.yourcompany.com`. Add the record Render shows at the company where you registered your domain. Then change `PUBLIC_URL` to the new address.

The `render.yaml` file includes a 1 GB disk, and that is where tickets are kept. Render only offers disks on paid instance types, so check the current price on their site. Without a disk, every restart erases all tickets.

## Option B: Your own server with Docker

You need an Ubuntu server (22.04 or 24.04, 1 GB memory is enough) and a domain name.

1. At your domain provider, create an **A record**: `help.yourcompany.com` pointing to your server's IP address.
2. Log in to the server and install Docker:
   ```
   curl -fsSL https://get.docker.com | sh
   ```
3. Copy this folder to the server (for example with `git clone` from your private repository, or `scp`).
4. Create your settings file and edit it:
   ```
   cp .env.example .env
   nano .env
   ```
   Set `STAFF_USERS`, `PUBLIC_URL`, `DOMAIN`, `SUPPORT_HOTLINE` and `SUPPORT_EMAIL`.
5. Start everything:
   ```
   docker compose up -d --build
   ```
   Caddy gets the https certificate for your domain by itself. This takes about a minute.
6. Open `https://help.yourcompany.com`. Staff sign in at `/staff`.
7. Allow only the ports you need:
   ```
   ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
   ```

Useful commands, run from this folder on the server:

| Task | Command |
|---|---|
| See live logs | `docker compose logs -f app` |
| Restart | `docker compose restart app` |
| Update after changing files | `docker compose up -d --build` |
| Stop everything | `docker compose down` |

## Option C: Your own server without Docker

1. Install Node.js 22.13 or newer.
2. Copy this folder to `/opt/nobicom-helpdesk`.
3. Create `/etc/systemd/system/helpdesk.service`:
   ```
   [Unit]
   Description=Nobicom help desk
   After=network.target

   [Service]
   WorkingDirectory=/opt/nobicom-helpdesk
   EnvironmentFile=/opt/nobicom-helpdesk/.env
   Environment=NODE_ENV=production TRUST_PROXY=1 PORT=3000 DB_PATH=/var/lib/helpdesk/helpdesk.db
   ExecStart=/usr/bin/node server.js
   Restart=always
   User=www-data
   StateDirectory=helpdesk

   [Install]
   WantedBy=multi-user.target
   ```
4. Run `systemctl enable --now helpdesk`.
5. Put Caddy or nginx in front for https. With Caddy the whole config is: `help.yourcompany.com { reverse_proxy localhost:3000 }`.

## Before you tell customers about it

- [ ] Every staff member has their own strong password.
- [ ] You opened the public address, sent a test question, signed in at `/staff`, replied, and checked the reply on the customer's ticket link.
- [ ] You set `PUBLIC_URL`, so ticket links shown to customers use your real address.
- [ ] Backups are running (below).
- [ ] You put a link to the help desk on your company website and in email signatures.

## Backups

All tickets are in one database file. Make a copy every day and keep it somewhere else.

- Docker: add this line to the server's crontab (`crontab -e`) to make a backup every night at 02:00:
  ```
  0 2 * * * cd /path/to/nobicom-helpdesk && docker compose exec -T app node scripts/backup.js /data/backups
  ```
  Then copy the backups out of Docker with `docker compose cp app:/data/backups ./backups` and store them on another machine or cloud drive.
- Without Docker: `node scripts/backup.js /var/backups/helpdesk`. The script keeps the 30 newest copies.

To restore, stop the app, replace the database file with a backup copy, and start the app again.

## Everyday tasks

- **Add or remove a staff member:** edit `STAFF_USERS` and restart the app.
- **Change the hotline or email shown:** edit `SUPPORT_HOTLINE` or `SUPPORT_EMAIL` and restart.
- **Update the software:** replace the files with the new version and rebuild (`docker compose up -d --build`, or push to GitHub on Render).

## Good to know

- Run exactly one copy of the app. It keeps tickets in a local database file, so it is not built to run on several servers at once.
- The app does not send emails. Staff check `/staff` for new tickets and customers check their ticket link.
- The app refuses to start in production if `STAFF_USERS` is missing or any password is shorter than 10 characters.
