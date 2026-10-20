"use strict";
/*
 * Nobicom Technology Integration PLC - Customer Help Desk
 * Zero-dependency Node.js app (needs Node 22.13 or newer).
 * Public side: customers send a question and track replies.
 * Staff side (/staff): sign in, answer, assign, change status.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

// ---------- configuration ----------
const PORT = Number(process.env.PORT || 3000);
const COMPANY = process.env.COMPANY_NAME || "Nobicom Technology Integration PLC";
const HOTLINE = process.env.SUPPORT_HOTLINE || "";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "helpdesk.db");
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const basePathInput = String(process.env.BASE_PATH || "").trim().replace(/^\/+|\/+$/g, "");
if (basePathInput && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(basePathInput)) throw new Error("BASE_PATH must contain only URL path segments (for example /support).");
const BASE_PATH = basePathInput ? `/${basePathInput}` : "";
const PRODUCTION = process.env.NODE_ENV === "production";

function parseUsers(raw) {
  const users = new Map();
  String(raw || "").split(",").forEach((pair) => {
    const i = pair.indexOf(":");
    if (i > 0) {
      const email = pair.slice(0, i).trim().toLowerCase();
      if (!isValidEmail(email) || !email.endsWith("@nobicomtech.com")) {
        throw new Error(`Invalid staff login email "${email}". Staff emails must use @nobicomtech.com.`);
      }
      users.set(email, pair.slice(i + 1));
    }
  });
  return users;
}
let STAFF = parseUsers(process.env.STAFF_USERS);
if (STAFF.size === 0) {
  if (PRODUCTION) {
    console.error("STAFF_USERS is not set. Set it (email:password,email:password) before starting in production.");
    process.exit(1);
  }
  STAFF = new Map([["admin@nobicomtech.com", "change-me-now"]]);
  console.warn("WARNING: STAFF_USERS is not set. Using admin@nobicomtech.com / change-me-now for local testing only.");
}
for (const [name, pw] of STAFF) {
  if (PRODUCTION && pw.length < 10) {
    console.error(`Password for staff user "${name}" is too short. Use at least 10 characters.`);
    process.exit(1);
  }
}

const STATUS = { new: "New", in_progress: "In progress", waiting_customer: "Waiting for customer", resolved: "Resolved" };
const PRIORITY = { normal: "Normal", high: "High", urgent: "Urgent" };
const CATEGORIES = ["Technical support", "After-sales service", "Quotation or sales", "Billing and payments", "Other"];
const KNOWLEDGE_CATEGORIES = ["Academic guide", "Study resource", "Training", "Career advice", "Policy", "Other"];
const OFFICIAL_LOGO_URL = "https://nobicomtech.com/wp-content/uploads/2024/10/image_2024-10-18_22-40-23-convert.io_.webp";

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    priority TEXT NOT NULL DEFAULT 'normal',
    assignee TEXT NOT NULL DEFAULT '',
    customer_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    csrf TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    token TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    body TEXT NOT NULL DEFAULT '',
    link_url TEXT NOT NULL DEFAULT '',
    published INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
try { db.exec("ALTER TABLE tickets ADD COLUMN customer_id INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE customers ADD COLUMN company_name TEXT NOT NULL DEFAULT ''"); } catch (e) {}

const q = {
  insertTicket: db.prepare("INSERT INTO tickets (token,name,email,phone,category,subject,priority,customer_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"),
  insertMsg: db.prepare("INSERT INTO messages (ticket_id,kind,author,body,created_at) VALUES (?,?,?,?,?)"),
  ticket: db.prepare("SELECT * FROM tickets WHERE id = ?"),
  msgs: db.prepare("SELECT * FROM messages WHERE ticket_id = ? ORDER BY id"),
  touch: db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?"),
  setStatus: db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?"),
  updateMeta: db.prepare("UPDATE tickets SET status=?, priority=?, assignee=?, updated_at=? WHERE id=?"),
  counts: db.prepare("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status"),
  knowledgeInsert: db.prepare("INSERT INTO knowledge (title, summary, category, body, link_url, published, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"),
  knowledgeAll: db.prepare("SELECT * FROM knowledge WHERE published = 1 ORDER BY created_at DESC LIMIT 50"),
  knowledgeRecent: db.prepare("SELECT * FROM knowledge WHERE published = 1 ORDER BY created_at DESC LIMIT 3"),
  knowledgeById: db.prepare("SELECT * FROM knowledge WHERE id = ? AND published = 1"),
  knowledgeAdmin: db.prepare("SELECT * FROM knowledge ORDER BY created_at DESC LIMIT 50"),
  customerInsert: db.prepare("INSERT INTO customers (name,company_name,email,phone,password_hash,created_at) VALUES (?,?,?,?,?,?)"),
  customerByEmail: db.prepare("SELECT * FROM customers WHERE email = ?"),
  customerById: db.prepare("SELECT * FROM customers WHERE id = ?"),
  customerTickets: db.prepare("SELECT * FROM tickets WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50"),
  newCustomerSession: db.prepare("INSERT INTO customer_sessions (token,customer_id,expires) VALUES (?,?,?)"),
  customerSession: db.prepare("SELECT c.* FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id WHERE cs.token = ? AND cs.expires > ?"),
  delCustomerSession: db.prepare("DELETE FROM customer_sessions WHERE token = ?"),
  newSession: db.prepare("INSERT INTO sessions (token,user,csrf,expires) VALUES (?,?,?,?)"),
  session: db.prepare("SELECT * FROM sessions WHERE token = ? AND expires > ?"),
  delSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  purgeSessions: db.prepare("DELETE FROM sessions WHERE expires <= ?"),
};

// ---------- helpers ----------
const refOf = (id) => "NTI-" + String(id).padStart(5, "0");
const idOfRef = (ref) => {
  const m = /^NTI-(\d{1,9})$/i.exec(String(ref).trim());
  return m ? Number(m[1]) : 0;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const now = () => new Date().toISOString();
const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Addis_Ababa", dateStyle: "medium", timeStyle: "short" });
const rand = (n) => crypto.randomBytes(n).toString("hex");
function isValidEmail(value) {
  const email = String(value || "").trim();
  if (email.length > 254) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2
    && labels.every((label) => label.length > 0 && label.length <= 63 && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label))
    && labels.at(-1).length >= 2;
}
function normPhone(value) {
  const phone = String(value || "").trim();
  if (!phone || !/^[+\d\s().-]+$/.test(phone)) return "";
  const digits = phone.replace(/\D/g, "");
  if (/^0[79]\d{8}$/.test(digits)) return digits.slice(1);
  if (/^[79]\d{8}$/.test(digits)) return digits;
  if (/^251[79]\d{8}$/.test(digits)) return digits.slice(3);
  return "";
}
const clip = (s, n) => String(s || "").trim().slice(0, n);
const safeEq = (a, b) => {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
const hashPassword = (password) => crypto.createHash("sha256").update(String(password || "")).digest("hex");

const hits = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(t); hits.set(key, arr); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 3600000)) hits.delete(k); q.purgeSessions.run(t); }, 600000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || "unknown";
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 100 * 1024) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
    req.on("error", reject);
  });
}

function isHttps(req) {
  return COOKIE_SECURE || (TRUST_PROXY && String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
}
function scopedPath(target) {
  if (!BASE_PATH || !target.startsWith("/") || target.startsWith("//") || target === BASE_PATH || target.startsWith(`${BASE_PATH}/`)) return target;
  return `${BASE_PATH}${target}`;
}
function scopeHtmlUrls(html) {
  return BASE_PATH ? html.replace(/\b(href|action|src)="\/(?!\/)/g, (_match, attribute) => `${attribute}="${BASE_PATH}/`) : html;
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...(COOKIE_SECURE || TRUST_PROXY ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...headers,
  });
  res.end(body);
}
const redirect = (res, to, headers = {}) => { res.writeHead(303, { Location: scopedPath(to), "Cache-Control": "no-store", ...headers }); res.end(); };

// ---------- views ----------
function layout(title, body, opts = {}) {
  const nav = opts.staff
    ? `<nav class="nav"><a href="/staff">Tickets</a><a href="/knowledge">Learning hub</a><form method="post" action="/staff/logout"><input type="hidden" name="_csrf" value="${esc(opts.staff.csrf)}"><span class="who">${esc(opts.staff.user)}</span><button class="link" type="submit">Sign out</button></form></nav>`
    : opts.customer
      ? `<nav class="nav customer-nav"><a href="/">Ask a question</a>
        <a href="/knowledge">Learning hub</a><a href="/track">Track a ticket</a>
         <div class="account-menu-wrap">
           <button type="button" class="account-trigger" aria-haspopup="true">My account</button>
           <div class="account-dropdown" aria-label="Account menu">
             <div class="account-dropdown-inner">
               <div class="account-dropdown-header">Uniportal Account</div>
               <div class="account-item"><a href="/account/user-center">User Center</a></div>
               <div class="account-item"><a href="/account/my-course">My Course</a></div>
               <div class="account-item"><a href="/account/my-information">My Information</a></div>
               <div class="account-item"><a href="/account/identity-verification">Identity Verification</a></div>
               <form method="post" action="/account/logout"><button type="submit" class="account-logout">Logout</button></form>
             </div>
           </div>
         </div>
         </nav>`
      : `<nav class="nav"><a href="/">Ask a question</a><a href="/knowledge">Learning hub</a><a href="/track">Track a ticket</a><a href="/account/login">Partner login</a></nav>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700&family=Poppins:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css?v=4"></head><body>
<header class="top"><div class="bar"><a class="brand" href="${opts.staff ? "/staff" : "/"}" aria-label="${esc(COMPANY)}"><img class="brand-mark" src="${OFFICIAL_LOGO_URL}" alt="${esc(COMPANY)}"></a>${nav}</div></header>
<main class="page${opts.home ? " home-page" : ""}${opts.softBlue ? " soft-blue-page" : ""}">${body}</main>
<footer class="foot">${esc(COMPANY)}${HOTLINE ? " &middot; Hotline " + esc(HOTLINE) : ""}${SUPPORT_EMAIL ? " &middot; " + esc(SUPPORT_EMAIL) : ""}</footer>
</body></html>`;
  return scopeHtmlUrls(html);
}

const pill = (status) => `<span class="pill s-${esc(status)}">${esc(STATUS[status] || status)}</span>`;

function askPage(v = {}, error = "", customer = null) {
  const opt = (c) => `<option${v.category === c ? " selected" : ""}>${esc(c)}</option>`;
  const knowledgeCards = q.knowledgeRecent.all().map((item) => `
    <article class="mini-resource">
      <span class="tag">${esc(item.category)}</span>
      <h3><a href="/knowledge/${item.id}">${esc(item.title)}</a></h3>
      <p>${esc(item.summary || item.body.slice(0, 120))}</p>
    </article>
  `).join("") || `<p class="empty-copy">No learning resources have been published yet.</p>`;
  return layout("Ask a question", `
  <section class="company-hero">
    <div class="hero-copy">
      <h1>NOBICOM Technology<br>Integration PLC</h1>
      <p>Bridging businesses with advanced ICT solutions, supply, and technical services tailored for educational, governmental, and private sectors across Ethiopia.</p>
      <div class="cta-row">
        <a href="#contact" class="btn primary">Ask a question</a>
        <a href="/track" class="btn secondary">Track a ticket</a>
      </div>
    </div>
  </section>

  <section class="home-lower">
    <form id="contact" class="card form home-form" method="post" action="/ask">
      ${customer
        ? `<div class="partner-priority"><div><strong>Partner priority</strong><p>Your request will receive priority handling.</p></div><span class="tag">Active</span></div>`
        : `<div class="partner-priority"><div><strong>Are you a partner?</strong><p>Sign in for priority support. Everyone can still ask a question below.</p></div><a class="btn secondary" href="/account/login">Partner login</a></div>`}
      <div class="form-title-row"><h2>Request support</h2><span>We reply quickly</span></div>
      ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
      <label>Your name<input name="name" required maxlength="100" value="${esc(v.name || customer?.name || "")}" autocomplete="name" ${customer ? "readonly" : ""}></label>
      <div class="two"><label>Email<input type="email" name="email" maxlength="150" value="${esc(v.email || customer?.email || "")}" autocomplete="email" ${customer ? "readonly" : ""}></label>
      <label>Phone<input name="phone" maxlength="40" value="${esc(v.phone || customer?.phone || "")}" autocomplete="tel" inputmode="tel" placeholder="09… or +251…" ${customer ? "readonly" : ""}></label></div>
      <p class="hint">Enter a valid email or Ethiopian mobile number (09…, 07…, or +251…). At least one is required.</p>
      <label>What is it about?<select name="category">${CATEGORIES.map((c) => `<option${(v.category || "Technical support") === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>Subject<input name="subject" required maxlength="150" value="${esc(v.subject || "")}"></label>
      <label>Your message<textarea name="message" required rows="6" maxlength="5000">${esc(v.message || "")}</textarea></label>
      <div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <button class="btn primary" type="submit">Send question</button>
      ${customer ? `<p class="muted">Signed in as ${esc(customer.name)}. <a href="/account">Open account</a></p>` : ""}
    </form>

    <div class="showcase-card">
      <p class="kicker">Why choose us</p>
      <h2>Built for performance, trust, and continuous improvement.</h2>
      <ul class="check-list">
        <li>Responsive technical support and consultation</li>
        <li>Education-focused learning resources and knowledge publishing</li>
        <li>Modern digital workflows for teams and customers</li>
        <li>Clear communication, service tracking, and accountability</li>
      </ul>
    </div>
  </section>

  <section class="feature-grid">
    <article class="feature-card"><div class="feature-icon">01</div><h3>IT Infrastructure</h3><p>Reliable systems, support, and business continuity for growing organizations.</p></article>
    <article class="feature-card"><div class="feature-icon">02</div><h3>Digital Learning</h3><p>Knowledge hubs, training resources, and educational guides that are easy to use.</p></article>
    <article class="feature-card"><div class="feature-icon">03</div><h3>Service Desk</h3><p>Fast issue tracking, structured support, and responsive ticket handling.</p></article>
    <article class="feature-card"><div class="feature-icon">04</div><h3>Smart Solutions</h3><p>Custom digital tools and practical technology designed around real business needs.</p></article>
  </section>

  <aside class="card quick-links">
    <div class="quick-head"><h2>Learning resources</h2><a href="/knowledge">View all</a></div>
    <div class="resource-list">${knowledgeCards}</div>
    <div class="stack-links"><a href="/knowledge">View all learning content</a>${HOTLINE ? `<a href="tel:${esc(HOTLINE)}">Call support</a>` : ""}${SUPPORT_EMAIL ? `<a href="mailto:${esc(SUPPORT_EMAIL)}">Email support</a>` : ""}</div>
  </aside>`, { customer, home: true });
}

function accountRegisterPage(error = "") {
  return layout("Create account", `
    <section class="hero"><p class="kicker">Customer account</p><h1>Create an account</h1><p>Sign up to manage tickets, track updates, and ask questions faster.</p></section>
    <form class="card form narrow" method="post" action="/account/signup">
      ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
      <label>Full name<input name="name" required maxlength="100"></label>
      <label>Company name<input name="company_name" required maxlength="150"></label>
      <label>Email<input name="email" type="email" required maxlength="150"></label>
      <label>Phone<input name="phone" maxlength="40" autocomplete="tel" inputmode="tel" placeholder="09… or +251…"></label>
      <label>Password<input type="password" name="password" required minlength="6" maxlength="128"></label>
      <label>Confirm password<input type="password" name="confirm_password" required minlength="6" maxlength="128"></label>
      <button class="btn primary" type="submit">Create account</button>
      <p class="muted">Already have an account? <a href="/account/login">Sign in</a></p>
    </form>
  `);
}

function accountLoginPage(error = "") {
  return layout("Partner login", `
    <section class="hero"><p class="kicker">Partner account</p><h1>Sign in</h1><p>Use your email and password to access your tickets and continue the conversation.</p></section>
    <form class="card form narrow" method="post" action="/account/login">
      ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
      <label>Email<input name="email" type="email" required maxlength="150"></label>
      <label>Password<input type="password" name="password" required maxlength="128"></label>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="muted">New customer? <a href="/account/signup">Create account</a></p>
    </form>
  `);
}

function customerDashboardPage(customer, tickets = [], error = "", activeSection = "my-information") {
  const username = (customer.name || customer.email || "user").toString().trim();
  const shortUser = username.includes("@") ? username.split("@")[0] : username;
  const safeUser = shortUser || "user";
  const sectionMap = {
    "user-center": "user-center",
    "my-course": "my-course",
    "my-information": "my-information",
    "identity-verification": "identity-verification"
  };
  const currentSection = sectionMap[activeSection] || "my-information";
  const ticketSummary = tickets.length
    ? `<ul>${tickets.map((t) => `<li><a href="/t/${refOf(t.id)}/${esc(t.token)}">${esc(refOf(t.id))} &middot; ${esc(t.subject)}</a> &ndash; ${esc(t.status)}</li>`).join("")}</ul>`
    : `<p>You have not created any tickets yet.</p>`;
  const sectionContent = {
    "user-center": `<h3>User Center</h3><p>Welcome to your portal dashboard. You can review your support history and learning content here.</p><h4>My Tickets</h4>${ticketSummary}`,
    "my-course": `<h3>My Course</h3><p>${tickets.length ? "You have enrolled learning content linked to your support history." : "You are not enrolled in any course yet."}</p><div class="portal-links"><a href="/knowledge">Explore learning hub</a></div>`,
    "my-information": `<h3>My Information</h3><p><strong>Name:</strong> ${esc(customer.name)}<br><strong>Company:</strong> ${esc(customer.company_name || "Not provided")}<br><strong>Email:</strong> ${esc(customer.email)}<br><strong>Phone:</strong> ${esc(customer.phone || "Not provided")}</p><div class="portal-links"><a href="/">Ask a new question</a><a href="/track">Track a ticket</a></div>`,
    "identity-verification": `<h3>Identity Verification</h3><p>Your account is active and verified for support access.</p>`
  }[currentSection];

  return layout("My account", `
    <style>
      .portal-wrap {
        display: block;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        min-height: 420px;
        box-shadow: var(--shadow-soft);
        overflow: hidden;
        animation: section-rise 0.65s ease-out both;
      }
      .portal-right {
        background: linear-gradient(180deg, #f8fbff 0%, #eef5ff 100%);
        padding: 32px clamp(18px, 4vw, 48px) 40px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .portal-userbox {
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }
      .portal-userbox .username {
        display: inline-block;
        min-width: 180px;
        text-align: center;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 12px 18px;
        font-size: 20px;
        font-weight: 600;
        color: var(--brand);
        letter-spacing: 0;
      }
      .portal-search {
        align-self: flex-end;
        width: 110px;
        height: 78px;
        border: 1px solid rgba(233, 59, 34, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255,255,255,0.35);
        color: #e63d2e;
        font-size: 44px;
        font-weight: 700;
      }
      .portal-panel h4 {
        margin: 20px 0 8px;
        color: #1c1c1c;
      }
      .portal-panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 24px;
        box-shadow: var(--shadow-soft);
      }
      .portal-panel h3 {
        margin: 0 0 12px;
        font-family: var(--font-heading);
        font-size: 26px;
        font-weight: 600;
        color: var(--brand);
        letter-spacing: 0;
      }
      .portal-panel p,
      .portal-panel li,
      .portal-panel a {
        font-size: 16px;
        line-height: 1.7;
        color: var(--fg);
      }
      .portal-panel ul {
        margin: 0;
        padding-left: 20px;
      }
      .portal-links {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 12px;
      }
      .portal-links a,
      .portal-links button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 16px;
        border: 1px solid var(--primary);
        border-radius: 6px;
        background: var(--primary);
        color: #fff;
        text-decoration: none;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s ease, transform 0.2s ease;
      }
      .portal-links a:hover,
      .portal-links button:hover {
        background: var(--brand);
        color: #fff;
        transform: translateY(-1px);
      }
    </style>

    <div class="portal-wrap">
      <div class="portal-right">
        <div class="portal-userbox">
          <span class="username">${esc(safeUser)}</span>
        </div>
        <section class="portal-panel">${sectionContent}</section>
      </div>
    </div>
  `, { customer, softBlue: true });
}

function trackPage(error = "", customer = null) {
  return layout("Track a ticket", `
  <section class="hero inner-hero"><p class="kicker">Support portal</p><h1>Track a ticket</h1><p>Check the latest status of a support request using its ticket number and the contact details you provided.</p></section>
  <form class="card form narrow track-form" method="post" action="/track">
    ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
    <label>Ticket number<input name="ref" required placeholder="NTI-00012" maxlength="20"></label>
    <label>Email or phone used<input name="contact" required maxlength="150"></label>
    <button class="btn primary" type="submit">Find my ticket</button>
  </form>`, { customer, softBlue: true });
}

function thread(msgs, forStaff) {
  return msgs.filter((m) => forStaff || m.kind !== "note").map((m) => `
    <article class="msg m-${esc(m.kind)}"><div class="meta"><strong>${esc(m.kind === "customer" ? m.author : m.kind === "note" ? m.author + " (internal note)" : m.author + ", " + COMPANY)}</strong><time>${esc(fmt(m.created_at))}</time></div><div class="text">${esc(m.body)}</div></article>`).join("");
}

function customerTicketPage(t, msgs, error = "", customer = null) {
  return layout(refOf(t.id), `
  <section class="hero"><div class="kicker mono">${refOf(t.id)}</div><h1>${esc(t.subject)}</h1><p>${pill(t.status)} <span class="muted">Opened ${esc(fmt(t.created_at))}</span></p></section>
  <div class="card thread">${thread(msgs, false)}</div>
  <form class="card form" method="post" action="/t/${refOf(t.id)}/${esc(t.token)}/reply">
    ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
    <label>${t.status === "resolved" ? "Need more help? Write here to reopen this ticket." : "Add a message"}<textarea name="message" required rows="4" maxlength="5000"></textarea></label>
    <button class="btn primary" type="submit">Send</button>
  </form>
  <p class="hint">Keep this page's address. It is your private link to this ticket.</p>`, { customer });
}

function loginPage(error = "") {
  return layout("Staff sign in", `
  <section class="hero"><h1>Staff sign in</h1></section>
  <form class="card form narrow" method="post" action="/staff/login">
    ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
    <label>Staff email<input type="email" name="user" required autocomplete="username" placeholder="name@nobicomtech.com"></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="btn primary" type="submit">Sign in</button>
  </form>`);
}

function knowledgeListPage(items = [], error = "", customer = null) {
  const cards = items.length
    ? items.map((item) => `
      <article class="resource-card">
        <div class="resource-head">
          <span class="tag">${esc(item.category)}</span>
          <span class="meta-date">${esc(fmt(item.created_at))}</span>
        </div>
        <h3><a href="/knowledge/${item.id}">${esc(item.title)}</a></h3>
        <p>${esc(item.summary || "Educational learning material")}</p>
        <div class="resource-actions">
          <a class="btn" href="/knowledge/${item.id}">Read</a>
          ${item.link_url ? `<a class="btn secondary" href="${esc(item.link_url)}" target="_blank" rel="noreferrer">Open link</a>` : ""}
        </div>
      </article>
    `).join("")
    : `<div class="card empty-box"><h3>No learning resources yet</h3><p>Staff can publish documents and links here.</p></div>`;
  return layout("Learning hub", `
    <section class="hero inner-hero"><p class="kicker">Knowledge base</p><h1>Learning hub</h1><p>Explore staff-published guides, tutorials, policy notes, and useful study links for students and learners.</p></section>
    ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
    <div class="resource-grid">${cards}</div>
  `, { customer, softBlue: true });
}

function knowledgePage(item, customer = null) {
  const body = item.body ? item.body.replace(/\n/g, "\n") : "";
  const link = item.link_url ? `<p><a class="btn primary" href="${esc(item.link_url)}" target="_blank" rel="noreferrer">Open resource</a></p>` : "";
  return layout(item.title, `
    <section class="hero inner-hero"><p class="kicker">${esc(item.category)}</p><h1>${esc(item.title)}</h1><p>${esc(item.summary)}</p></section>
    <article class="card article-card">
      ${link}
      <div class="article-body">${esc(body).replace(/\n/g, "<br>")}</div>
    </article>
  `, { customer, softBlue: true });
}

function staffListPage(session, url) {
  const status = url.searchParams.get("status") || "open";
  const who = url.searchParams.get("who") || "";
  const text = (url.searchParams.get("q") || "").trim();
  const where = []; const args = [];
  if (status === "open") where.push("status != 'resolved'");
  else if (STATUS[status]) { where.push("status = ?"); args.push(status); }
  if (who === "me") { where.push("assignee = ?"); args.push(session.user); }
  else if (who === "none") where.push("assignee = ''");
  if (text) {
    const id = idOfRef(text) || (/^\d+$/.test(text) ? Number(text) : 0);
    const like = "%" + text.replace(/[%_]/g, "") + "%";
    where.push("(id = ? OR subject LIKE ? OR name LIKE ? OR email LIKE ? OR phone LIKE ?)");
    args.push(id, like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM tickets ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200`).all(...args);
  const counts = Object.fromEntries(q.counts.all().map((r) => [r.status, r.n]));
  const knowledge = q.knowledgeAdmin.all().slice(0, 5);
  const tile = (key, label) => `<a class="tile${status === key ? " on" : ""}" href="/staff?status=${key}"><span class="n">${counts[key] || 0}</span><span>${esc(label)}</span></a>`;
  return layout("Tickets", `
  <h1 class="h1">Support desk</h1>
  <div class="tiles">${tile("new", "New")}${tile("in_progress", "In progress")}${tile("waiting_customer", "Waiting for customer")}${tile("resolved", "Resolved")}</div>
  <div class="two-panel-layout">
    <div class="panel-stack">
      <form class="filters" method="get" action="/staff">
        <select name="status" aria-label="Status"><option value="open"${status === "open" ? " selected" : ""}>All open</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${status === k ? " selected" : ""}>${v}</option>`).join("")}</select>
        <select name="who" aria-label="Assigned to"><option value="">Anyone</option><option value="me"${who === "me" ? " selected" : ""}>Assigned to me</option><option value="none"${who === "none" ? " selected" : ""}>Unassigned</option></select>
        <input name="q" value="${esc(text)}" placeholder="Search name, phone, email, ticket number" aria-label="Search">
        <button class="btn" type="submit">Filter</button>
      </form>
      <div class="tablewrap"><table><thead><tr><th>Ticket</th><th>Subject</th><th>Customer</th><th>Status</th><th>Priority</th><th>Assigned</th><th>Updated</th></tr></thead><tbody>
      ${rows.map((t) => `<tr><td class="mono"><a href="/staff/t/${t.id}">${refOf(t.id)}</a></td><td><a href="/staff/t/${t.id}">${esc(t.subject)}</a><div class="muted">${esc(t.category)}</div></td><td>${esc(t.name)}<div class="muted">${esc(t.email || t.phone)}</div></td><td>${pill(t.status)}</td><td><span class="prio p-${esc(t.priority)}">${esc(PRIORITY[t.priority])}</span></td><td>${esc(t.assignee || "Unassigned")}</td><td class="muted">${esc(fmt(t.updated_at))}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">No tickets match. New customer questions appear here.</td></tr>`}
      </tbody></table></div>
    </div>
    <aside class="panel-stack">
      <div class="card publish-card">
        <h2>Publish learning content</h2>
        <form class="form compact" method="post" action="/staff/knowledge/new">
          <input type="hidden" name="_csrf" value="${esc(session.csrf)}">
          <label>Title<input name="title" required maxlength="150"></label>
          <label>Category<select name="category">${KNOWLEDGE_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
          <label>Summary<textarea name="summary" rows="3" maxlength="400" required></textarea></label>
          <label>Document or article text<textarea name="body" rows="6" maxlength="15000" placeholder="Paste notes, steps, or learning guidance..."></textarea></label>
          <label>External link<input name="link_url" maxlength="300" type="url" placeholder="https://example.com"></label>
          <div class="checkbox-row"><input type="checkbox" name="published" checked><label>Published</label></div>
          <button class="btn primary" type="submit">Publish</button>
        </form>
      </div>
      <div class="card resource-rail">
        <h2>Recent learning resources</h2>
        <div class="mini-resource-list">
          ${knowledge.map((item) => `<div class="mini-item"><span class="tag">${esc(item.category)}</span><a href="/knowledge/${item.id}">${esc(item.title)}</a></div>`).join("") || `<p class="empty-copy">No public resources yet.</p>`}
        </div>
        <a class="btn secondary" href="/knowledge">Open learning hub</a>
      </div>
    </aside>
  </div>`, { staff: session });
}

function staffTicketPage(session, t, msgs, error = "") {
  const staffNames = [...STAFF.keys()];
  const opts = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${cur === k ? " selected" : ""}>${esc(v)}</option>`).join("");
  return layout(refOf(t.id), `
  <p><a href="/staff">&larr; All tickets</a></p>
  <section class="hero left"><div class="kicker mono">${refOf(t.id)} &middot; ${esc(t.category)}</div><h1>${esc(t.subject)}</h1><p>${pill(t.status)} <span class="muted">Opened ${esc(fmt(t.created_at))}</span></p></section>
  <div class="cols wide">
    <div>
      <div class="card thread">${thread(msgs, true)}</div>
      <form class="card form" method="post" action="/staff/t/${t.id}/reply">
        <input type="hidden" name="_csrf" value="${esc(session.csrf)}">
        ${error ? `<p class="alert" role="alert">${esc(error)}</p>` : ""}
        <label>Message<textarea name="message" required rows="5" maxlength="5000"></textarea></label>
        <div class="two">
          <label>Send as<select name="kind"><option value="staff">Reply to customer</option><option value="note">Internal note (customer cannot see)</option></select></label>
          <label>Then set status<select name="status"><option value="">Automatic</option>${opts(STATUS, "")}</select></label>
        </div>
        <button class="btn primary" type="submit">Post</button>
      </form>
    </div>
    <aside>
      <form class="card form" method="post" action="/staff/t/${t.id}/update">
        <input type="hidden" name="_csrf" value="${esc(session.csrf)}">
        <h2>Handling</h2>
        <label>Status<select name="status">${opts(STATUS, t.status)}</select></label>
        <label>Priority<select name="priority">${opts(PRIORITY, t.priority)}</select></label>
        <label>Assigned to<select name="assignee"><option value="">Unassigned</option>${staffNames.map((n) => `<option${t.assignee === n ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <button class="btn" type="submit">Save</button>
      </form>
      <div class="card side"><h2>Customer</h2><dl><dt>Name</dt><dd>${esc(t.name)}</dd>${t.email ? `<dt>Email</dt><dd class="mono">${esc(t.email)}</dd>` : ""}${t.phone ? `<dt>Phone</dt><dd class="mono">${esc(t.phone)}</dd>` : ""}</dl></div>
    </aside>
  </div>`, { staff: session });
}

// ---------- request handling ----------
function authed(req) {
  const sid = parseCookies(req).sid;
  return sid ? q.session.get(sid, Date.now()) : undefined;
}

function customerAuthed(req) {
  const sid = parseCookies(req).customer_sid;
  return sid ? q.customerSession.get(sid, Date.now()) : undefined;
}

function loadCustomerTicket(ref, token) {
  const id = idOfRef(ref);
  const t = id ? q.ticket.get(id) : undefined;
  return t && safeEq(t.token, token) ? t : undefined;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requestPath = url.pathname.replace(/\/+$/, "") || "/";
  const p = BASE_PATH && (requestPath === BASE_PATH || requestPath.startsWith(`${BASE_PATH}/`))
    ? requestPath.slice(BASE_PATH.length) || "/"
    : requestPath;
  const method = req.method;
  const ip = clientIp(req);
  let m;

  if (method === "GET" && ["/style.css", "/hero-bg.svg", "/logo.svg", "/nobicom-hero.webp"].includes(p)) {
    const file = p.slice(1);
    const mime = file.endsWith(".svg") ? "image/svg+xml" : file.endsWith(".webp") ? "image/webp" : "text/css; charset=utf-8";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=300" });
    const contents = fs.readFileSync(path.join(__dirname, "public", file), file.endsWith(".css") ? "utf8" : undefined);
    return res.end(file.endsWith(".css") ? contents.replace(/url\((["']?)\/(?!\/)/g, (_match, quote) => `url(${quote}${BASE_PATH}/`) : contents);
  }
  if (method === "GET" && p === "/healthz") return send(res, 200, "ok", { "Content-Type": "text/plain" });

  // ----- public -----
  const customer = customerAuthed(req);
  if (method === "GET" && p === "/") return send(res, 200, askPage({}, "", customer), { "Cache-Control": "no-store" });
  if (method === "POST" && p === "/ask") {
    const f = await readForm(req);
    if (f.website) return redirect(res, "/");
    const currentCustomer = customerAuthed(req);
    if (limited("ask:" + ip, 8, 3600000)) return send(res, 429, askPage(f, "Too many messages from this connection. Please try again later.", currentCustomer));
    const v = { name: clip(f.name, 100), email: clip(f.email, 150), phone: clip(f.phone, 40), category: CATEGORIES.includes(f.category) ? f.category : "Other", subject: clip(f.subject, 150), message: clip(f.message, 5000) };
    if (!v.name || !v.subject || !v.message) return send(res, 400, askPage(v, "Please fill in your name, subject and message.", currentCustomer));
    if (!v.email && !v.phone) return send(res, 400, askPage(v, "Please give an email or a phone number so we can reach you.", currentCustomer));
    if (v.email && !isValidEmail(v.email)) return send(res, 400, askPage(v, "Enter a valid email address.", currentCustomer));
    if (v.phone && !normPhone(v.phone)) return send(res, 400, askPage(v, "Enter a valid Ethiopian mobile number: 09…, 07…, or +251… .", currentCustomer));
    const token = rand(16); const t = now();
    const priority = currentCustomer ? "high" : "normal";
    const info = q.insertTicket.run(token, v.name, v.email, v.phone, v.category, v.subject, priority, currentCustomer ? currentCustomer.id : null, t, t);
    const id = Number(info.lastInsertRowid);
    q.insertMsg.run(id, "customer", v.name, v.message, t);
    const base = PUBLIC_URL || `${TRUST_PROXY && req.headers["x-forwarded-proto"] ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim() : "http"}://${req.headers.host}`;
    const publicBase = BASE_PATH && !base.endsWith(BASE_PATH) ? `${base}${BASE_PATH}` : base;
    const link = `${publicBase}/t/${refOf(id)}/${token}`;
    return send(res, 200, layout("Question received", `
      <section class="hero"><h1>We received your question</h1><p>Your ticket number is</p><div class="refbig mono">${refOf(id)}</div></section>
      <div class="card"><p>Our team will reply on your ticket page. Save this private link to check progress and write back:</p>
      <p class="mono linkbox"><a href="/t/${refOf(id)}/${token}">${esc(link)}</a></p>
      <p class="hint">You can also use <a href="/track">Track a ticket</a> with the number and your ${v.email ? "email" : "phone"}.</p></div>`, { customer: currentCustomer }));
  }
  if (method === "GET" && p === "/account/login") return customer ? redirect(res, "/account") : send(res, 200, accountLoginPage());
  if (method === "POST" && p === "/account/login") {
    if (customer) return redirect(res, "/account");
    if (limited("customer-login:" + ip, 10, 900000)) return send(res, 429, accountLoginPage("Too many attempts. Please wait a few minutes."));
    const f = await readForm(req);
    const email = String(f.email || "").trim().toLowerCase();
    const password = String(f.password || "");
    const user = email ? q.customerByEmail.get(email) : undefined;
    if (!user || user.password_hash !== hashPassword(password)) return send(res, 401, accountLoginPage("Wrong email or password."));
    const sid = rand(32);
    q.newCustomerSession.run(sid, user.id, Date.now() + 12 * 3600000);
    return redirect(res, "/", { "Set-Cookie": `customer_sid=${sid}; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Lax; Max-Age=43200${isHttps(req) ? "; Secure" : ""}` });
  }
  if (method === "GET" && p === "/account/signup") return customer ? redirect(res, "/account") : send(res, 200, accountRegisterPage());
  if (method === "POST" && p === "/account/signup") {
    if (customer) return redirect(res, "/account");
    if (limited("customer-signup:" + ip, 10, 900000)) return send(res, 429, accountRegisterPage("Too many attempts. Please wait a few minutes."));
    const f = await readForm(req);
    const email = String(f.email || "").trim().toLowerCase();
    const name = clip(f.name, 100).trim();
    const companyName = clip(f.company_name, 150).trim();
    const phone = clip(f.phone, 40).trim();
    const password = String(f.password || "");
    const confirmPassword = String(f.confirm_password || "");
    if (!name || !companyName || !email || password.length < 6) return send(res, 400, accountRegisterPage("Please provide a valid name, company name, email, and password with at least 6 characters."));
    if (password !== confirmPassword) return send(res, 400, accountRegisterPage("Passwords do not match. Please re-enter them."));
    if (!isValidEmail(email)) return send(res, 400, accountRegisterPage("Enter a valid email address."));
    if (phone && !normPhone(phone)) return send(res, 400, accountRegisterPage("Enter a valid Ethiopian mobile number: 09…, 07…, or +251… ."));
    if (q.customerByEmail.get(email)) return send(res, 409, accountRegisterPage("An account already exists for this email."));
    const inserted = q.customerInsert.run(name, companyName, email, phone, hashPassword(password), now());
    const sid = rand(32);
    q.newCustomerSession.run(sid, Number(inserted.lastInsertRowid), Date.now() + 12 * 3600000);
    return redirect(res, "/account", { "Set-Cookie": `customer_sid=${sid}; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Lax; Max-Age=43200${isHttps(req) ? "; Secure" : ""}` });
  }
  if (p === "/account" || p.startsWith("/account/")) {
    if (!customer) return redirect(res, "/account/login");
    if (method === "POST" && p === "/account/logout") {
      q.delCustomerSession.run(parseCookies(req).customer_sid || "");
      return redirect(res, "/account/login", { "Set-Cookie": `customer_sid=; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (method === "GET") {
      const accountSections = {
        "/account": "my-information",
        "/account/user-center": "user-center",
        "/account/my-course": "my-course",
        "/account/my-information": "my-information",
        "/account/identity-verification": "identity-verification"
      };
      if (accountSections[p]) return send(res, 200, customerDashboardPage(customer, q.customerTickets.all(customer.id), "", accountSections[p]));
    }
  }
  if (method === "GET" && p === "/track") return send(res, 200, trackPage("", customer));
  if (method === "POST" && p === "/track") {
    if (limited("track:" + ip, 15, 900000)) return send(res, 429, trackPage("Too many attempts. Please wait a few minutes.", customer));
    const f = await readForm(req);
    const id = idOfRef(f.ref); const t = id ? q.ticket.get(id) : undefined;
    const c = String(f.contact || "").trim().toLowerCase();
    const ok = t && c && ((t.email && t.email.toLowerCase() === c) || (t.phone && normPhone(t.phone) && normPhone(t.phone) === normPhone(c)));
    if (!ok) return send(res, 404, trackPage("We could not find a ticket with those details.", customer));
    return redirect(res, `/t/${refOf(t.id)}/${t.token}`);
  }
  if (method === "GET" && p === "/knowledge") return send(res, 200, knowledgeListPage(q.knowledgeAll.all(), "", customer));
  if ((m = /^\/knowledge\/(\d+)$/.exec(p)) && method === "GET") {
    const item = q.knowledgeById.get(Number(m[1]));
    if (!item) return send(res, 404, layout("Resource not found", `<section class="hero"><h1>Resource not found</h1><p><a href="/knowledge">Return to the learning hub</a>.</p></section>`, { customer }));
    return send(res, 200, knowledgePage(item, customer));
  }
  if ((m = /^\/t\/([^/]+)\/([0-9a-f]{32})$/.exec(p)) && method === "GET") {
    const t = loadCustomerTicket(m[1], m[2]);
    if (!t) return send(res, 404, layout("Not found", `<section class="hero"><h1>Ticket not found</h1><p>Check the link, or <a href="/track">track your ticket</a> with its number.</p></section>`, { customer }));
    return send(res, 200, customerTicketPage(t, q.msgs.all(t.id), "", customer));
  }
  if ((m = /^\/t\/([^/]+)\/([0-9a-f]{32})\/reply$/.exec(p)) && method === "POST") {
    const t = loadCustomerTicket(m[1], m[2]);
    if (!t) return send(res, 404, layout("Not found", `<section class="hero"><h1>Ticket not found</h1></section>`, { customer }));
    if (limited("reply:" + ip, 20, 3600000)) return send(res, 429, customerTicketPage(t, q.msgs.all(t.id), "Too many messages. Please try again later.", customer));
    const f = await readForm(req); const body = clip(f.message, 5000);
    if (!body) return send(res, 400, customerTicketPage(t, q.msgs.all(t.id), "Please write a message.", customer));
    const ts = now();
    q.insertMsg.run(t.id, "customer", t.name, body, ts);
    q.setStatus.run(t.status === "resolved" || t.status === "waiting_customer" ? "in_progress" : t.status, ts, t.id);
    return redirect(res, `/t/${refOf(t.id)}/${t.token}`);
  }

  // ----- staff -----
  if (method === "GET" && p === "/staff/login") return send(res, 200, loginPage());
  if (method === "POST" && p === "/staff/login") {
    if (limited("login:" + ip, 10, 900000)) return send(res, 429, loginPage("Too many attempts. Please wait 15 minutes."));
    const f = await readForm(req);
    const email = String(f.user || "").trim().toLowerCase();
    const pw = email.endsWith("@nobicomtech.com") && isValidEmail(email) ? STAFF.get(email) : undefined;
    if (pw === undefined || !safeEq(pw, f.password || "")) return send(res, 401, loginPage("Use your @nobicomtech.com email and password."));
    const sid = rand(32);
    q.newSession.run(sid, email, rand(16), Date.now() + 12 * 3600000);
    return redirect(res, "/staff", { "Set-Cookie": `sid=${sid}; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Lax; Max-Age=43200${isHttps(req) ? "; Secure" : ""}` });
  }
  if (p === "/staff" || p.startsWith("/staff/")) {
    const s = authed(req);
    if (!s) return redirect(res, "/staff/login");
    if (method === "POST") {
      var f = await readForm(req);
      if (!f._csrf || !safeEq(f._csrf, s.csrf)) return send(res, 403, layout("Blocked", `<section class="hero"><h1>Session expired</h1><p><a href="/staff">Go back</a> and try again.</p></section>`, { staff: s }));
    }
    if (method === "POST" && p === "/staff/logout") {
      q.delSession.run(s.token);
      return redirect(res, "/staff/login", { "Set-Cookie": `sid=; Path=${BASE_PATH || "/"}; HttpOnly; SameSite=Lax; Max-Age=0` });
    }
    if (method === "POST" && p === "/staff/knowledge/new") {
      const f = await readForm(req);
      const title = clip(f.title, 150).trim();
      const summary = clip(f.summary, 400).trim();
      const category = KNOWLEDGE_CATEGORIES.includes(String(f.category || "")) ? String(f.category) : "Other";
      const body = clip(f.body, 15000);
      const linkUrl = String(f.link_url || "").trim();
      const published = f.published === "on" || f.published === "1" ? 1 : 0;
      if (!title || !summary) return send(res, 400, staffListPage(s, url));
      const ts = now();
      q.knowledgeInsert.run(title, summary, category, body, linkUrl, published, s.user, ts, ts);
      return redirect(res, "/staff");
    }
    if (method === "GET" && p === "/staff") return send(res, 200, staffListPage(s, url));
    if ((m = /^\/staff\/t\/(\d+)$/.exec(p)) && method === "GET") {
      const t = q.ticket.get(Number(m[1]));
      return t ? send(res, 200, staffTicketPage(s, t, q.msgs.all(t.id))) : send(res, 404, layout("Not found", `<section class="hero"><h1>Ticket not found</h1></section>`, { staff: s }));
    }
    if ((m = /^\/staff\/t\/(\d+)\/reply$/.exec(p)) && method === "POST") {
      const t = q.ticket.get(Number(m[1]));
      if (!t) return send(res, 404, layout("Not found", `<section class="hero"><h1>Ticket not found</h1></section>`, { staff: s }));
      const body = clip(f.message, 5000);
      if (!body) return send(res, 400, staffTicketPage(s, t, q.msgs.all(t.id), "Write a message first."));
      const kind = f.kind === "note" ? "note" : "staff"; const ts = now();
      q.insertMsg.run(t.id, kind, s.user, body, ts);
      let next = STATUS[f.status] ? f.status : t.status;
      if (!STATUS[f.status] && kind === "staff") next = t.status === "new" ? "in_progress" : t.status;
      if (!t.assignee) db.prepare("UPDATE tickets SET assignee = ? WHERE id = ?").run(s.user, t.id);
      q.setStatus.run(next, ts, t.id);
      return redirect(res, `/staff/t/${t.id}`);
    }
    if ((m = /^\/staff\/t\/(\d+)\/update$/.exec(p)) && method === "POST") {
      const t = q.ticket.get(Number(m[1]));
      if (!t) return send(res, 404, layout("Not found", `<section class="hero"><h1>Ticket not found</h1></section>`, { staff: s }));
      const status = STATUS[f.status] ? f.status : t.status;
      const priority = PRIORITY[f.priority] ? f.priority : t.priority;
      const assignee = STAFF.has(f.assignee) ? f.assignee : "";
      q.updateMeta.run(status, priority, assignee, now(), t.id);
      return redirect(res, `/staff/t/${t.id}`);
    }
  }

  return send(res, 404, layout("Not found", `<section class="hero"><h1>Page not found</h1><p><a href="/">Back to the help desk</a></p></section>`, { customer }));
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, layout("Error", `<section class="hero"><h1>Something went wrong</h1><p>Please try again in a moment.</p></section>`));
  });
});
server.listen(PORT, "0.0.0.0", () => console.log(`${COMPANY} help desk listening on port ${PORT}`));
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
