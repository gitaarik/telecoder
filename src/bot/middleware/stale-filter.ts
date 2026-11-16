const BOT_START_TIME = Date.now();
const STALE_THRESHOLD = 30000; // 30 seconds

export function isStaleMessage(messageDate: number): boolean {
  // messageDate is Unix timestamp in seconds, convert to ms
  const messageDateMs = messageDate * 1000;

  // Ignore messages sent before bot started (minus threshold)
  return messageDateMs < BOT_START_TIME - STALE_THRESHOLD;
}
