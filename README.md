# Nobicom Help Desk

A customer help desk for Nobicom Technology Integration PLC.

- **Customers** open your website, send a question, and get a ticket number (like NTI-00012) and a private link. They come back to that link to read your replies and write back. They can also look a ticket up with the number plus their email or phone.
- **Your team** signs in at `/staff`, sees every ticket, replies, leaves internal notes, assigns tickets to a colleague, sets priority, and marks tickets resolved.

No packages to install. It needs only **Node.js 22.13 or newer**.

## Try it on your own computer

1. Install Node.js 22 from https://nodejs.org
2. Open a terminal in this folder and run:

```
STAFF_USERS="amanuel@nobicomtech.com:choose-a-password,hanna@nobicomtech.com:another-password" node server.js
```

On Windows PowerShell:

```
$env:STAFF_USERS="amanuel@nobicomtech.com:choose-a-password,hanna@nobicomtech.com:another-password"; node server.js
```

3. Customers page: http://localhost:3000  Staff page: http://localhost:3000/staff

## Settings

Set these as environment variables (see `.env.example`).

| Setting | What it does |
|---|---|
| `STAFF_USERS` | Staff logins as `email:password,email:password`. Emails must end in `@nobicomtech.com`. **Required before going live.** |
| `COMPANY_NAME` | Name shown on every page. Default is Nobicom Technology Integration PLC. |
| `SUPPORT_HOTLINE` | Hotline number shown on the site. |
| `SUPPORT_EMAIL` | After-sales email shown on the site. |
| `PORT` | Port to listen on. Default 3000. |
| `DB_PATH` | Where the database file is kept. Default `data/helpdesk.db`. Put it on a disk that survives restarts. |
| `PUBLIC_URL` | The public address, such as `https://help.yourcompany.com`. Used in the ticket links customers see. |
| `NODE_ENV` | Set to `production` online. The app then refuses to start without strong staff passwords. |
| `TRUST_PROXY` | Set to `1` when a hosting service or proxy sits in front, so rate limits see real visitor addresses and cookies are marked secure over https. |
| `COOKIE_SECURE` | Set to `1` to force secure cookies. Not needed when `TRUST_PROXY` is on and the proxy uses https. |

## Putting it on the internet

See **DEPLOY.md** for step-by-step instructions for Render, for your own server with Docker (https included), and for a server without Docker. It also covers backups and a go-live checklist.

## What it does not do yet

- It does not send email or SMS. Customers check their ticket link, and staff check the dashboard. Email alerts to staff and customers are the most useful next addition.
- File attachments, a Telegram or WhatsApp channel, and Amharic pages are not included.
- Staff passwords are set in the settings, not inside the app. To add or remove a person, change `STAFF_USERS` and restart.
