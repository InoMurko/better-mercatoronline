/**
 * One shared, logged-in HTTP session for the CLI and the bot. Login happens lazily and again whenever the
 * shop says we're logged out (sessions expire). Read-only calls don't need a login and run concurrently.
 */
import "dotenv/config";
import { Http } from "../core/http.ts";
import { ensureSession, isLoggedIn, login } from "../shop/auth.ts";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return v;
}

export class ShopSession {
  readonly http = new Http();
  private checkedAt = 0;
  private pending: Promise<void> | null = null;

  /** A logged-in client (checks at most every 5 minutes, logs in again when needed). */
  async loggedIn(): Promise<Http> {
    if (Date.now() - this.checkedAt < 5 * 60_000) return this.http;
    this.pending ??= (async () => {
      const creds = { email: requireEnv("MERCATOR_EMAIL"), password: requireEnv("MERCATOR_PASSWORD") };
      if (this.checkedAt === 0) await ensureSession(this.http, creds);
      else if (!(await isLoggedIn(this.http))) {
        await login(this.http, creds.email, creds.password);
        this.http.saveSession(".session.json");
      }
      this.checkedAt = Date.now();
    })().finally(() => (this.pending = null));
    await this.pending;
    return this.http;
  }

  /** For read-only calls (search etc.) – no login needed. */
  get anon(): Http {
    return this.http;
  }
}
