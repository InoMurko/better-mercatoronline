/**
 * Text that reaches your terminal, container logs or a Telegram reply from outside (shop pages, recipe sites,
 * the model, error messages): no control characters (no terminal escape sequences, no fake log lines),
 * no bidi tricks, bounded length – and never a secret from .env.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;

/** Strip control/bidi characters (keeps newlines and tabs) and cap the length. */
export function safeText(s: unknown, max = 2000): string {
  const t = String(s ?? "").replace(CONTROL, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const SECRET_ENV = ["TELEGRAM_BOT_TOKEN", "MERCATOR_PASSWORD", "ANTHROPIC_API_KEY"];

/** Replace secrets with placeholders: the values from .env, plus anything shaped like a bot token or an Anthropic key. */
export function redact(s: string): string {
  let out = s;
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 6) out = out.split(v).join(`<${name}>`);
  }
  return out
    .replace(/\bbot\d{6,12}:[A-Za-z0-9_-]{30,}/g, "bot<TELEGRAM_BOT_TOKEN>")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<TELEGRAM_BOT_TOKEN>")
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "<ANTHROPIC_API_KEY>");
}

/** An error as one safe string: message (+ stack and cause), redacted and stripped. */
export function describeError(err: unknown, { stack = false } = {}): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    if (e instanceof Error) {
      parts.push(stack && e.stack ? e.stack : `${e.name === "Error" ? "" : `${e.name}: `}${e.message}`);
      e = (e as Error & { cause?: unknown; error?: unknown }).cause ?? (e as { error?: unknown }).error;
    } else {
      parts.push(typeof e === "string" ? e : JSON.stringify(e));
      break;
    }
  }
  return safeText(redact(parts.join("\n  caused by: ")), stack ? 4000 : 500);
}

/** console.error for anything that might carry outside text or secrets. */
export function logError(label: string, err: unknown) {
  console.error(`${safeText(label, 200)}: ${describeError(err, { stack: true })}`);
}

/**
 * Make console.log/info/warn/error safe for the whole process: string arguments are stripped of control
 * characters and secrets, Error objects are printed as redacted text. Shop names, model answers and error
 * messages from other servers all pass through here on the way to your terminal or the container log.
 */
export function installSafeConsole() {
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) =>
      original(...args.map((a) => (typeof a === "string" ? safeText(redact(a), 8000) : a instanceof Error ? describeError(a, { stack: true }) : a)));
  }
}
