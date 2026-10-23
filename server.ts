import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Polyfill Web Crypto MD5 digest used by Cloudflare Workers S3 middleware
const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
globalThis.crypto.subtle.digest = async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
  const algName = typeof algorithm === 'string' ? algorithm : algorithm?.name;
  if (algName && algName.toUpperCase() === 'MD5') {
    const view = ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data as ArrayBuffer);
    const md5Buf = crypto.createHash('md5').update(view).digest();
    return md5Buf.buffer.slice(md5Buf.byteOffset, md5Buf.byteOffset + md5Buf.byteLength);
  }
  return originalDigest(algorithm, data);
};

// Local D1-compatible SQLite wrapper using Node 22 built-in node:sqlite
class LocalD1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: any[];

  constructor(db: DatabaseSync, sql: string, params: any[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: any[]) {
    const normalized = values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
    return new LocalD1PreparedStatement(this.db, this.sql, normalized);
  }

  private isReaderSql(): boolean {
    const trimmed = this.sql.trim().toUpperCase();
    return (
      trimmed.startsWith('SELECT') ||
      trimmed.startsWith('PRAGMA') ||
      trimmed.startsWith('WITH') ||
      /\bRETURNING\b/i.test(trimmed)
    );
  }

  async all() {
    const stmt = this.db.prepare(this.sql);
    if (this.isReaderSql()) {
      const rows = stmt.all(...this.params) as Record<string, any>[];
      return { results: rows, success: true, meta: {} };
    } else {
      const info = stmt.run(...this.params);
      return {
        results: [],
        success: true,
        meta: {
          changes: Number(info.changes ?? 0),
          last_row_id: Number(info.lastInsertRowid ?? 0),
        },
      };
    }
  }

  async first(colName?: string) {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, any> | undefined;
    if (!row) return null;
    if (colName) return row[colName] ?? null;
    return row;
  }

  async run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  async raw(options?: { columnNames?: boolean }) {
    const stmt = this.db.prepare(this.sql) as any;
    if (typeof stmt.setReturnArrays === 'function') {
      stmt.setReturnArrays(true);
      const rows = stmt.all(...this.params) as any[][];
      return rows;
    }
    const rows = stmt.all(...this.params) as Record<string, any>[];
    if (options?.columnNames && rows.length > 0) {
      return [Object.keys(rows[0]), ...rows.map((r) => Object.values(r))];
    }
    return rows.map((r) => Object.values(r));
  }
}

class LocalD1Database {
  public sqlite: DatabaseSync;

  constructor(dbPath: string) {
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA foreign_keys = OFF;');
  }

  prepare(sql: string) {
    return new LocalD1PreparedStatement(this.sqlite, sql);
  }

  async batch(statements: LocalD1PreparedStatement[]) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.all());
    }
    return results;
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}

// Local KV & R2 store backed by memory + disk persistence
class LocalKVNamespace {
  private store = new Map<string, { value: any; metadata?: any; isBinary?: boolean }>();
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
        for (const [k, v] of Object.entries(raw)) {
          this.store.set(k, v as any);
        }
      }
    } catch (e) {
      console.warn('Failed to load KV store from disk:', e);
    }
  }

  private saveToDisk() {
    try {
      const serializable: Record<string, any> = {};
      for (const [k, v] of this.store.entries()) {
        if (!v.isBinary) {
          serializable[k] = v;
        }
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(serializable, null, 2), 'utf-8');
    } catch (e) {
      console.warn('Failed to persist KV store:', e);
    }
  }

  async get(key: string, options?: { type?: string } | string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const type = typeof options === 'string' ? options : options?.type || 'text';
    if (type === 'json') {
      return typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
    }
    if (type === 'arrayBuffer') {
      if (entry.value instanceof ArrayBuffer) return entry.value;
      if (Buffer.isBuffer(entry.value)) {
        return entry.value.buffer.slice(entry.value.byteOffset, entry.value.byteOffset + entry.value.byteLength);
      }
      if (ArrayBuffer.isView(entry.value)) {
        return entry.value.buffer.slice(entry.value.byteOffset, entry.value.byteOffset + entry.value.byteLength);
      }
      return Buffer.from(String(entry.value)).buffer;
    }
    return entry.value;
  }

  async put(key: string, value: any, options?: { metadata?: any; expirationTtl?: number }) {
    const isBinary = value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Buffer.isBuffer(value);
    this.store.set(key, {
      value,
      metadata: options?.metadata || {},
      isBinary,
    });
    if (!isBinary) {
      this.saveToDisk();
    }
  }

  async delete(key: string) {
    this.store.delete(key);
    this.saveToDisk();
  }

  async getWithMetadata(key: string, options?: { type?: string }) {
    const entry = this.store.get(key);
    if (!entry) return { value: null, metadata: null };
    const value = await this.get(key, options);
    return { value, metadata: entry.metadata || null };
  }
}

async function hashPassword(password: string, saltStr?: string) {
  const encoder = new TextEncoder();
  let salt = saltStr;
  if (!salt) {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    salt = Buffer.from(array).toString('base64');
  }
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hash = Buffer.from(new Uint8Array(hashBuffer)).toString('base64');
  return { salt, hash };
}

async function bootstrapDatabaseAndSeed(worker: any, env: any, d1: LocalD1Database) {
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  };

  // Run official mail-worker schema migrations and setting cache initialization
  const initReq = new Request(`http://localhost:3000/api/init/${env.jwt_secret}`, {
    method: 'GET',
  });
  const initRes = await worker.fetch(initReq, env, ctx);
  const initText = await initRes.text();
  console.log('[Cloud Mail] Database schema initialization:', initText);

  // Configure local-friendly settings:
  // register = 0 (OPEN), send = 0 (OPEN), many_email = 0 (OPEN), add_email = 0 (OPEN)
  // register_verify = 1 (CLOSE Turnstile CAPTCHA), add_email_verify = 1 (CLOSE Turnstile CAPTCHA), reg_key = 1 (CLOSE)
  d1.sqlite.exec(`
    UPDATE setting SET
      register = 0,
      receive = 0,
      send = 0,
      many_email = 0,
      add_email = 0,
      register_verify = 1,
      add_email_verify = 1,
      reg_key = 1,
      auto_refresh = 5,
      title = 'Cloud Mail'
  `);

  // Allow default role to send internal emails without ban
  d1.sqlite.exec(`
    UPDATE role SET
      send_type = 'internal',
      account_count = 20
    WHERE role_id = 1
  `);

  // Check if default admin user exists
  const existingAdmin = d1.sqlite
    .prepare(`SELECT user_id FROM user WHERE email = ? LIMIT 1`)
    .get(env.admin) as { user_id: number } | undefined;

  if (!existingAdmin) {
    console.log('[Cloud Mail] Seeding default admin user, mailbox accounts, and sample emails...');
    const { salt: adminSalt, hash: adminHash } = await hashPassword('admin123');
    const { salt: aliceSalt, hash: aliceHash } = await hashPassword('alice123');

    const now = new Date();
    const fmtDate = (daysAgo: number, hoursOffset = 0) => {
      const d = new Date(now.getTime() - daysAgo * 86400000 + hoursOffset * 3600000);
      return d.toISOString().replace('T', ' ').slice(0, 19);
    };

    // Insert admin@example.com (user_id = 1) and alice@example.com (user_id = 2)
    d1.sqlite
      .prepare(
        `INSERT INTO user (user_id, email, type, password, salt, status, create_time, active_time, create_ip, active_ip, os, browser, device, sort, send_count, reg_key_id, is_del)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?, '127.0.0.1', '127.0.0.1', 'Linux', 'Chrome 130', 'Desktop', 10, 2, 0, 0)`
      )
      .run(1, env.admin, adminHash, adminSalt, fmtDate(5), fmtDate(0));

    d1.sqlite
      .prepare(
        `INSERT INTO user (user_id, email, type, password, salt, status, create_time, active_time, create_ip, active_ip, os, browser, device, sort, send_count, reg_key_id, is_del)
         VALUES (?, ?, 1, ?, ?, 0, ?, ?, '127.0.0.1', '127.0.0.1', 'macOS', 'Safari 18', 'Desktop', 0, 1, 0, 0)`
      )
      .run(2, 'alice@example.com', aliceHash, aliceSalt, fmtDate(3), fmtDate(1));

    // Insert mailbox accounts for admin (user_id = 1) and alice (user_id = 2)
    const insertAccount = d1.sqlite.prepare(
      `INSERT INTO account (account_id, email, name, status, latest_email_time, create_time, user_id, all_receive, sort, is_del)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 0)`
    );
    insertAccount.run(1, 'admin@example.com', 'admin', fmtDate(0), fmtDate(5), 1, 0, 10);
    insertAccount.run(2, 'work@example.com', 'work', fmtDate(1), fmtDate(4), 1, 0, 8);
    insertAccount.run(3, 'alerts@example.com', 'alerts', fmtDate(2), fmtDate(3), 1, 0, 6);
    insertAccount.run(4, 'alice@example.com', 'alice', fmtDate(1), fmtDate(3), 2, 0, 0);

    // Insert sample emails
    const insertEmail = d1.sqlite.prepare(
      `INSERT INTO email (
        email_id, send_email, name, account_id, user_id, subject, content, text,
        create_time, is_del, type, status, recipient, cc, bcc, message_id, in_reply_to, relation, to_email, to_name, unread
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '[]', '[]', ?, '', '', ?, ?, ?)`
    );

    const sampleEmails = [
      {
        id: 1,
        sendEmail: 'team@cloudmail.dev',
        name: 'Cloud Mail Team',
        accountId: 1,
        userId: 1,
        subject: 'Welcome to Cloud Mail — Your Full-Stack Workspace is Ready',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <h2 style="margin-bottom: 8px; color: #111827;">Welcome to Cloud Mail</h2>
          <p>Your local full-stack Cloud Mail instance is up and running on <strong>port 3000</strong> with a local SQLite D1 database and KV storage.</p>
          <ul>
            <li><strong>Default Admin Account:</strong> <code>admin@example.com</code> (Password: <code>admin123</code>)</li>
            <li><strong>Configured Domains:</strong> <code>@example.com</code>, <code>@example2.com</code>, <code>@example3.com</code>, <code>@example4.com</code></li>
            <li><strong>Multi-Account Support:</strong> Switch between <code>admin@example.com</code>, <code>work@example.com</code>, and <code>alerts@example.com</code> in the left pane.</li>
          </ul>
          <p>Try composing an internal email to <code>alice@example.com</code> or exploring the Analytics and System Settings panels!</p>
        </div>`,
        text: 'Welcome to Cloud Mail! Your local full-stack Cloud Mail instance is up and running on port 3000.',
        createTime: fmtDate(0, -1),
        type: 0, // RECEIVE
        status: 0, // RECEIVE
        recipient: JSON.stringify([{ address: 'admin@example.com', name: 'admin' }]),
        messageId: '<welcome-01@cloudmail.dev>',
        toEmail: 'admin@example.com',
        toName: 'admin',
        unread: 0,
      },
      {
        id: 2,
        sendEmail: 'alice@example.com',
        name: 'Alice Chen',
        accountId: 1,
        userId: 1,
        subject: 'Q4 Infrastructure Migration & Mail Routing Checklist',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <p>Hi Admin,</p>
          <p>I have completed testing the new multi-domain routing rules for <code>@example.com</code> and <code>@example2.com</code>. All inbound webhooks and RBAC role permissions verified cleanly.</p>
          <p>Let me know when we are ready to enable external Resend tokens for production delivery.</p>
          <p>Best regards,<br/><strong>Alice Chen</strong><br/>Platform Engineering</p>
        </div>`,
        text: 'Hi Admin, I have completed testing the new multi-domain routing rules for @example.com and @example2.com.',
        createTime: fmtDate(1, -3),
        type: 0,
        status: 0,
        recipient: JSON.stringify([{ address: 'admin@example.com', name: 'admin' }]),
        messageId: '<q4-checklist-02@example.com>',
        toEmail: 'admin@example.com',
        toName: 'admin',
        unread: 0,
      },
      {
        id: 3,
        sendEmail: 'security-noreply@github.com',
        name: 'GitHub Security',
        accountId: 1,
        userId: 1,
        subject: '[GitHub] Dependabot alert resolved in cloud-mail repository',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <p>Good news! The automated security update for <strong>cloud-mail</strong> has been merged and verified.</p>
          <p>All runtime dependencies for both <code>mail-vue</code> and <code>mail-worker</code> are up to date.</p>
        </div>`,
        text: 'Good news! The automated security update for cloud-mail has been merged and verified.',
        createTime: fmtDate(2, -2),
        type: 0,
        status: 0,
        recipient: JSON.stringify([{ address: 'admin@example.com', name: 'admin' }]),
        messageId: '<gh-sec-03@github.com>',
        toEmail: 'admin@example.com',
        toName: 'admin',
        unread: 1,
      },
      {
        id: 4,
        sendEmail: 'billing@cloudflare.com',
        name: 'Cloudflare Billing',
        accountId: 2,
        userId: 1,
        subject: 'Invoice #CF-2026-1084 for Workers & D1 Usage',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <p>Hello,</p>
          <p>Your monthly usage summary for <code>work@example.com</code> is ready. Total scheduled Worker invocations and D1 queries remained within the free tier allocation ($0.00 due).</p>
        </div>`,
        text: 'Your monthly usage summary for work@example.com is ready.',
        createTime: fmtDate(1, -5),
        type: 0,
        status: 0,
        recipient: JSON.stringify([{ address: 'work@example.com', name: 'work' }]),
        messageId: '<cf-inv-04@cloudflare.com>',
        toEmail: 'work@example.com',
        toName: 'work',
        unread: 0,
      },
      {
        id: 5,
        sendEmail: 'monitor@uptime.internal',
        name: 'Uptime Monitor',
        accountId: 3,
        userId: 1,
        subject: '[RESOLVED] SMTP Relay Latency Normalized (18ms avg)',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <p><strong>Status:</strong> Nominal (99.98% uptime over 30 days)</p>
          <p>Inbound mail parser and attachment storage health checks passed across all edge regions.</p>
        </div>`,
        text: 'Status: Nominal. Inbound mail parser and attachment storage health checks passed.',
        createTime: fmtDate(3, -4),
        type: 0,
        status: 0,
        recipient: JSON.stringify([{ address: 'alerts@example.com', name: 'alerts' }]),
        messageId: '<uptime-05@uptime.internal>',
        toEmail: 'alerts@example.com',
        toName: 'alerts',
        unread: 1,
      },
      {
        id: 6,
        sendEmail: 'admin@example.com',
        name: 'admin',
        accountId: 1,
        userId: 1,
        subject: 'Re: Q4 Infrastructure Migration & Mail Routing Checklist',
        content: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1f2937;">
          <p>Thanks Alice! Everything looks great on the dashboard. Let's proceed with the rollout this afternoon.</p>
        </div>`,
        text: 'Thanks Alice! Everything looks great on the dashboard. Let us proceed with the rollout this afternoon.',
        createTime: fmtDate(1, -1),
        type: 1, // SEND
        status: 2, // DELIVERED
        recipient: JSON.stringify([{ address: 'alice@example.com', name: 'alice' }]),
        messageId: '<reply-q4-06@example.com>',
        toEmail: 'alice@example.com',
        toName: 'alice',
        unread: 1,
      },
    ];

    for (const m of sampleEmails) {
      insertEmail.run(
        m.id,
        m.sendEmail,
        m.name,
        m.accountId,
        m.userId,
        m.subject,
        m.content,
        m.text,
        m.createTime,
        m.type,
        m.status,
        m.recipient,
        m.messageId,
        m.toEmail,
        m.toName,
        m.unread
      );
    }

    // Star the first two emails for admin
    const insertStar = d1.sqlite.prepare(
      `INSERT INTO star (star_id, user_id, email_id, create_time) VALUES (?, ?, ?, ?)`
    );
    insertStar.run(1, 1, 1, fmtDate(0));
    insertStar.run(2, 1, 2, fmtDate(1));
  }

  // Refresh KV settings cache after our setting table adjustments
  const settingRow = d1.sqlite.prepare(`SELECT * FROM setting LIMIT 1`).get() as Record<string, any>;
  if (settingRow) {
    const camelSetting = {
      register: settingRow.register,
      receive: settingRow.receive,
      title: settingRow.title,
      manyEmail: settingRow.many_email,
      addEmail: settingRow.add_email,
      autoRefresh: settingRow.auto_refresh,
      addEmailVerify: settingRow.add_email_verify,
      registerVerify: settingRow.register_verify,
      regVerifyCount: settingRow.reg_verify_count,
      addVerifyCount: settingRow.add_verify_count,
      send: settingRow.send,
      r2Domain: settingRow.r2_domain,
      secretKey: settingRow.secret_key,
      siteKey: settingRow.site_key,
      regKey: settingRow.reg_key,
      background: settingRow.background,
      tgBotToken: settingRow.tg_bot_token,
      tgChatId: settingRow.tg_chat_id,
      tgBotStatus: settingRow.tg_bot_status,
      forwardEmail: settingRow.forward_email,
      forwardStatus: settingRow.forward_status,
      ruleEmail: settingRow.rule_email,
      ruleType: settingRow.rule_type,
      loginOpacity: settingRow.login_opacity,
      resendTokens: JSON.parse(settingRow.resend_tokens || '{}'),
      noticeTitle: settingRow.notice_title,
      noticeContent: settingRow.notice_content,
      noticeType: settingRow.notice_type,
      noticeDuration: settingRow.notice_duration,
      noticePosition: settingRow.notice_position,
      noticeOffset: settingRow.notice_offset,
      noticeWidth: settingRow.notice_width,
      notice: settingRow.notice,
      noRecipient: settingRow.no_recipient,
      loginDomain: settingRow.login_domain,
      bucket: settingRow.bucket,
      region: settingRow.region,
      endpoint: settingRow.endpoint,
      s3AccessKey: settingRow.s3_access_key,
      s3SecretKey: settingRow.s3_secret_key,
      forcePathStyle: settingRow.force_path_style,
      customDomain: settingRow.custom_domain,
      tgMsgFrom: settingRow.tg_msg_from,
      tgMsgTo: settingRow.tg_msg_to,
      tgMsgText: settingRow.tg_msg_text,
      minEmailPrefix: settingRow.min_email_prefix,
      emailPrefixFilter: settingRow.email_prefix_filter,
      blackSubject: settingRow.black_subject,
      blackContent: settingRow.black_content,
      blackFrom: settingRow.black_from,
    };
    await env.kv.put('setting:', JSON.stringify(camelSetting));
  }
}

async function buildWorkerBundle() {
  const { build } = await import('esbuild');
  const outfile = path.resolve(__dirname, 'mail-worker/.dist-worker.mjs');
  await build({
    entryPoints: [path.resolve(__dirname, 'mail-worker/src/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@aws-sdk/client-s3'],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    outfile,
    logLevel: 'silent',
  });
  return import(outfile);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function parseDomains(rawDomains?: string): string[] {
  const defaults = ['example.com', 'example2.com', 'example3.com', 'example4.com'];
  if (!rawDomains || !rawDomains.trim()) return defaults;

  let parsed: string[] = [];
  try {
    const json = JSON.parse(rawDomains);
    if (Array.isArray(json)) {
      parsed = json.map(String);
    } else if (typeof json === 'string') {
      parsed = [json];
    }
  } catch {
    parsed = rawDomains.split(/[\s,]+/).filter(Boolean);
  }

  const normalized = parsed
    .map((d) => d.trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean)
    .map((d) => (d.includes('.') ? d : `${d}.com`));

  return Array.from(new Set([...defaults, ...normalized]));
}

async function startServer() {
  // Always bind to port 3000 as required by AI Studio runtime
  const port = 3000;
  const isProd = process.env.NODE_ENV === 'production';

  // 1. Bundle mail-worker so extensionless imports work seamlessly in Node ESM
  const workerMod = await buildWorkerBundle();
  const worker = workerMod.default;

  // 2. Initialize local D1 SQLite & KV bindings
  const dataDir = path.resolve(__dirname, '.data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const d1 = new LocalD1Database(path.join(dataDir, 'cloud-mail.sqlite'));
  const kv = new LocalKVNamespace(path.join(dataDir, 'cloud-mail-kv.json'));

  const domains = parseDomains(process.env.DOMAINS);
  const rawAdmin = (process.env.ADMIN_EMAIL || '').trim();
  const resolvedAdmin =
    rawAdmin && rawAdmin.includes('@') && rawAdmin.includes('.')
      ? rawAdmin
      : 'admin@example.com';

  const env = {
    db: d1,
    kv,
    orm_log: false,
    domain: domains,
    admin: resolvedAdmin,
    jwt_secret: process.env.JWT_SECRET || 'b7f29a1d-18e2-4d3b-941f-f6b2c97c02fd',
    assets: {
      fetch: async () => new Response('Not Found', { status: 404 }),
    },
  };

  // 3. Auto-initialize schema & seed default admin + demo emails
  await bootstrapDatabaseAndSeed(worker, env, d1);

  // 4. Ensure frontend dist is built so requests are served with zero on-the-fly transform failures
  const distDir = path.resolve(__dirname, 'mail-vue/dist');
  const distIndex = path.join(distDir, 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.log('[Cloud Mail] Building mail-vue frontend bundle...');
    const { build: viteBuild } = await import('vite');
    await viteBuild({
      configFile: path.resolve(__dirname, 'mail-vue/vite.config.js'),
      mode: 'release',
      logLevel: 'warn',
    });
  }

  const vite: any = null;

  const server = http.createServer(async (req, res) => {
    try {
      const urlStr = req.url || '/';
      const parsedUrl = new URL(urlStr, `http://${req.headers.host || 'localhost:3000'}`);

      // Route backend API and KV object paths to mail-worker Hono handler
      if (
        parsedUrl.pathname.startsWith('/api/') ||
        parsedUrl.pathname.startsWith('/static/') ||
        parsedUrl.pathname.startsWith('/attachments/')
      ) {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else if (typeof value === 'string') {
            headers.set(key, value);
          }
        }

        let body: Buffer | undefined = undefined;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          body = Buffer.concat(chunks);
        }

        const webReq = new Request(parsedUrl.toString(), {
          method: req.method,
          headers,
          body: body ? (body as unknown as BodyInit) : undefined,
        });

        const ctx = {
          waitUntil: () => {},
          passThroughOnException: () => {},
        };

        const webRes: Response = await worker.fetch(webReq, env, ctx);
        res.statusCode = webRes.status;
        webRes.headers.forEach((val, key) => {
          res.setHeader(key, val);
        });
        const arrayBuf = await webRes.arrayBuffer();
        res.end(Buffer.from(arrayBuf));
        return;
      }

      // Serve frontend via Vite in dev mode
      if (vite) {
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end('Not Found');
        });
        return;
      }

      // Serve built static files in production mode
      let filePath = path.join(distDir, decodeURIComponent(parsedUrl.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
      } else {
        const indexHtml = path.join(distDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          fs.createReadStream(indexHtml).pipe(res);
        } else {
          res.statusCode = 404;
          res.end('Frontend build not found');
        }
      }
    } catch (err: any) {
      console.error('[Cloud Mail Server Error]', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 500, message: err?.message || 'Internal Server Error' }));
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Cloud Mail] Full-stack server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Cloud Mail server:', err);
  process.exit(1);
});
