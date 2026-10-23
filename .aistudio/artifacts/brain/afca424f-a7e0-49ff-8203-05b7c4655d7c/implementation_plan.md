# Fix Cloud Mail Dev Server Startup (Full-Stack Port 3000)

Fix the broken development server startup by creating the missing root workspace entry point (`npm run dev` on `0.0.0.0:3000`) that serves the `mail-vue` frontend and mounts the `mail-worker` Hono API in a single Node.js process with an auto-initialized local database.

### User Review & Critical Decisions

> [!IMPORTANT]
> **Why the dev server didn't start**: The imported repository contains two separate sub-projects (`mail-vue` configured for port 3001 and `mail-worker` configured for Cloudflare `wrangler dev`) with no root `package.json` or unified port 3000 server entry.
>
> Click **Proceed** on this plan to apply the fix and start the dev server with your confirmed settings below:

- **Confirmed Decision 1 — Full-Stack Server on Port 3000**: Run the Vue 3 Vite frontend and local Hono backend API together on `0.0.0.0:3000` from the root `npm run dev` script.
- **Confirmed Decision 2 — Auto-Initialized Database & Default Admin**: Automatically initialize all SQLite tables on server startup and seed the default administrator account (`admin@example.com` / `admin123`) so login works immediately.
- **Confirmed Decision 3 — Pre-Populated Sample Mailbox**: Pre-populate sample inbox emails, starred messages, and demo mailbox accounts (`admin@example.com`, `work@example.com`, `alerts@example.com`) for immediate testing.

---

### 1. Overview & Core Concept

- **What It Does**: Restores and runs the full Cloud Mail webmail application in the AI Studio preview environment on port 3000, uniting the Vue 3 + Element Plus client with the Hono backend API and a local D1/KV persistence layer.
- **Target Audience / Persona**: Users and administrators testing and managing multi-domain email accounts, reading and composing HTML emails, and reviewing mail analytics locally.
- **Key Value**: Resolves the startup failure immediately without requiring external Cloudflare Worker/D1/KV credentials or multi-port processes.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Instant Sign-In & Registration**: Users open the app on port 3000 and sign in directly with the pre-seeded admin account (`admin@example.com` / `admin123`) or register a new mailbox on `@example.com` without CAPTCHA blockers.
  2. **Inbox, Starred & Multi-Account Switching**: Users browse pre-populated HTML emails across `admin@example.com`, `work@example.com`, and `alerts@example.com`, view rendered HTML message bodies, star/unstar messages, and delete or filter mail.
  3. **Rich-Text Email Composition**: Clicking the compose button launches the TinyMCE editor to write, format, and send emails locally between accounts.
  4. **Admin & Analytics Dashboard**: Administrators inspect ECharts mail volume statistics, manage users and RBAC role permissions, generate registration keys, and update system settings.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Preserves Cloud Mail's native utilitarian SaaS interface built with Element Plus and responsive light/dark mode support.
  - *Color Palette & Mood*: Neutral workspace background (`#FFFFFF` light / `#141414` dark), subtle structural surfaces (`#F1F1F1` / `#1E1E1E`), primary accent blue (`#409EFF`), and semantic status colors (`#67C23A` active/delivered, `#E6A23C` warning, `#F56C6C` error).
  - *Typography & Hierarchy*: Crisp sans-serif UI typography for mail lists and navigation, with `tabular-nums` alignment for timestamps, unread badges, and analytics metrics.
  - *Component Styling & Layout*: Full-viewport desktop layout (`1440px` baseline) featuring a collapsible sidebar navigation rail, secondary account switcher, and main content pane separated by 1px hairline borders.
- **Interactive Feedback & Motion**: NProgress route transition bar, skeleton loading placeholders for mail lists, smooth drawer transitions on mobile viewports, and Element Plus toast feedback on all actions.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Root Unified Dev & Production Server (`0.0.0.0:3000`)**
  - *Chosen Approach*: Provide a root `package.json` and unified server script that binds to `0.0.0.0:3000`, attaches the `mail-worker` Hono router to `/api/*`, `/static/*`, and `/attachments/*`, and integrates Vite middleware for the `mail-vue` frontend.
  - *Why*: Guarantees `npm run dev` boots on port 3000 in a single process as required by the runtime environment.
  - *Alternatives Considered*: Running `wrangler dev` + `vite --port 3001` separately was rejected because only port 3000 is exposed and `wrangler` requires Cloudflare daemon bindings.
- **Decision 2: Local D1 SQLite & KV Compatibility Adapter**
  - *Chosen Approach*: Inject a local SQLite D1-compatible binding (`prepare`, `bind`, `all`, `first`, `run`, `batch`, `raw`) and KV/R2 memory-and-disk adapter into Hono's `c.env` context.
  - *Why*: Runs all existing Drizzle ORM queries, raw SQL schema migrations, JWT token checks, and RBAC permission guards unmodified.
- **Decision 3: Auto-Migration & Demo Mailbox Seeding on Startup**
  - *Chosen Approach*: Run the database migration steps automatically before accepting requests, configure `/api` as the default Axios base URL, disable mandatory Turnstile verification by default, and seed `admin@example.com` (`admin123`) plus sample emails.
  - *Why*: Eliminates manual `/api/init/:secret` setup steps and provides an immediately usable inbox.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

- **Architecture & Component Diagram**:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Root Node.js Server (0.0.0.0:3000)                      │
├───────────────────────────────────┬──────────────────────────────────────┤
│     Vue 3 + Vite SPA Middleware   │       Hono Worker API Router         │
│                                   │                                      │
│  ┌─────────────────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Workspace Views & Modals    │  │  │ Auth & RBAC Security Guard     │  │
│  │ • Login & Registration      │  │  │ • JWT Token Validation         │  │
│  │ • Inbox, Starred, Sent      │  │  │ • Role Permission Matching     │  │
│  │ • TinyMCE Compose Dialog    │  │  └───────────────┬────────────────┘  │
│  │ • Admin, Roles & ECharts    │  │                  ▼                   │
│  └──────────────┬──────────────┘  │  ┌────────────────────────────────┐  │
│                 ▼                 │  │ Mail Worker Services           │  │
│  ┌─────────────────────────────┐  │  │ • Login, User, Account, Role   │  │
│  │ Pinia Stores & Axios (/api) │──┼─▶│ • Email, Star, All-Email       │  │
│  │ • Auth Header Injection     │  │  │ • Settings, RegKey & Analytics │  │
│  │ • Dynamic Route Mounting    │  │  └───────────────┬────────────────┘  │
│  └─────────────────────────────┘  │                  ▼                   │
│                                   │  ┌────────────────────────────────┐  │
│                                   │  │ Local D1 + KV + R2 Env Bridge  │  │
│                                   │  │ • SQLite D1 Adapter (Drizzle)  │  │
│                                   │  │ • KV Session & Setting Cache   │  │
│                                   │  │ • Startup Schema & Demo Seeder │  │
│                                   │  └────────────────────────────────┘  │
└───────────────────────────────────┴──────────────────────────────────────┘
```

- **Data Model & State**:
  - **Authentication & RBAC (`user`, `role`, `perm`, `role_perm`)**: Manages user accounts, salted password hashes, default roles, and route/UI permission keys.
  - **Mailboxes & Messages (`account`, `email`, `star`, `attachments`)**: Tracks user mailbox addresses across domains (`@example.com`, `@example2.com`, etc.), inbound/outbound HTML emails, unread states, starred flags, and attachments.
  - **Settings & Sessions (`setting`, KV store)**: Persists global application configuration and active JWT session records (`auth-info:<userId>`).
- **Interactive Component & State Mapping**:
  - **Startup & Config Hydration**: On page load, `websiteConfig()` fetches `/api/setting/websiteConfig`, populating `useSettingStore` with title, domain list, and registration settings.
  - **Login & Dynamic Routing**: Submitting credentials to `/api/login` returns a JWT, fetches `/api/my/loginUserInfo`, hydrates `useUserStore` and `useAccountStore`, and registers authorized views in Vue Router.
  - **Mailbox Operations**: Switching accounts, starring messages, composing/sending emails, and managing system settings execute live queries against the local D1 SQLite adapter and update the Vue UI reactively.
