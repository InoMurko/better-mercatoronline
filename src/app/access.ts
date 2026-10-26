/**
 * Who may use the bot: only you, in your private chat with it.
 * Checks the chat AND the sender – a group chat id (or any update whose sender isn't you) is ignored,
 * so adding the bot to a family group can't hand that group your cart and orders.
 */
export type Who = { chat?: { id: number; type: string } | null; from?: { id: number } | null; text?: string | null };
export type Verdict = "owner" | "setup" | "ignore";

export function admit(u: Who, owner: number | null): Verdict {
  if (owner == null) return u.chat?.type === "private" && /^\/start(@\w+)?(\s|$)/.test(u.text ?? "") ? "setup" : "ignore";
  if (u.chat?.type !== "private" || u.chat.id !== owner) return "ignore";
  if (u.from && u.from.id !== owner) return "ignore";
  return "owner";
}

/** Log ignored chats at most once an hour each (strangers can't flood the logs), remembering at most 200. */
export function shouldLog(seen: Map<number, number>, chatId: number, now = Date.now()): boolean {
  const last = seen.get(chatId);
  if (last != null && now - last < 3600_000) return false;
  if (seen.size >= 200 && last == null) seen.delete(seen.keys().next().value!);
  seen.set(chatId, now);
  return true;
}
