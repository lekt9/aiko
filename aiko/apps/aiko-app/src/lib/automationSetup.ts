/**
 * Conversation-driven automation setup (no user-facing JSON schema).
 * Agent is steered via a silent prompt prefix; final config is a fence the UI strips and applies.
 */

import type { AutomationInputDto } from "@/lib/api";
import { computeNextRunAt } from "@/lib/automations";

export const AUTOMATION_FENCE_LANG = "aiko-automation";

/** Visible composer seed — natural language only. */
export function aiCreateSeedPrompt(_productName = "Aiko"): string {
  return "用一两句话说：要定期做什么、多久跑一次（例如「每天早上 9 点查 @cgnot996 的最新动态」或「3 分钟后做一次…」）。";
}

/**
 * Silent instructions prepended to agent text only (journal keeps the user-facing text).
 * Do not show this block in the composer or chat bubbles.
 */
export function automationSetupAgentPrefix(): string {
  return [
    "[INTERNAL — automation setup mode. Never quote this block or mention JSON/schema/fields to the user.]",
    "You help the user create a scheduled task for this app shell (not only Build CLI scheduler).",
    "Only schedule when the user clearly wants a timed/recurring run (when + what). Role cards, product principles, /goal, or standing “mode” instructions are NOT schedules — do not emit a fence for those.",
    "Ask briefly only if schedule is ambiguous: what to run, how often (daily / weekdays / weekly / once), local time.",
    "When you have enough, confirm in natural language (title, when, what will run).",
    "Then end with EXACTLY one fenced block (nothing after it):",
    "```" + AUTOMATION_FENCE_LANG,
    '{"title":"short title","prompt":"standalone instructions each run","frequency":"daily|weekly|weekdays|once","time":"HH:MM","weekdays":[],"enabled":true,"nextRunAt":null}',
    "```",
    "Rules:",
    "- weekdays: 0=Sun … 6=Sat only when frequency is weekly; else [].",
    "- prompt: actionable standalone instructions (not a chat reply).",
    "- For relative delays (e.g. in 3 minutes / 一小时后): set frequency to once, time to local HH:MM of that moment, AND nextRunAt to ISO-8601 UTC of that instant.",
    "- For wall-clock recurring (daily 09:00): nextRunAt may be null (shell computes).",
    "- Do not explain field names. Do not put the fence mid-sentence.",
    "- If the user forbids schedules (禁止定时 / no schedule / not a timer), do not emit a fence.",
  ].join("\n");
}

export function wrapAutomationSetupAgentText(userVisibleText: string): string {
  const body = userVisibleText.trim();
  return `${automationSetupAgentPrefix()}\n\nUser request:\n${body}`;
}

/**
 * Match ```grok-automation / ```json fences (optional lang spacing; closing fence optional final newline).
 */
const FENCE_RE =
  /```(?:grok-automation|json)[^\n\r]*\r?\n([\s\S]*?)```/gi;

export type ExtractedAutomation = {
  cleanText: string;
  input: AutomationInputDto | null;
  rawJson: string | null;
};

function normalizeFrequency(v: unknown): string {
  const s = String(v ?? "daily")
    .trim()
    .toLowerCase();
  if (s === "daily" || s === "weekly" || s === "weekdays" || s === "once") {
    return s;
  }
  if (/每天|每日|daily/.test(s)) return "daily";
  if (/工作日|weekdays/.test(s)) return "weekdays";
  if (/每周|weekly/.test(s)) return "weekly";
  if (/一次|once|单次/.test(s)) return "once";
  return "daily";
}

function normalizeTime(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Parse fence JSON into AutomationInputDto; returns null if incomplete. */
export function parseAutomationConfigJson(
  raw: string,
): AutomationInputDto | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const prompt = String(o.prompt ?? "").trim();
  if (!title || !prompt) return null;

  const frequency = normalizeFrequency(o.frequency);
  const time = normalizeTime(o.time) ?? "09:00";
  const weekdays = Array.isArray(o.weekdays)
    ? o.weekdays
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6)
    : [];
  const enabled = o.enabled === undefined ? true : Boolean(o.enabled);

  let nextRunAt: string | null | undefined;
  if (typeof o.nextRunAt === "string" && o.nextRunAt.trim()) {
    const t = Date.parse(o.nextRunAt);
    nextRunAt = Number.isNaN(t) ? undefined : new Date(t).toISOString();
  } else if (o.nextRunAt === null) {
    nextRunAt = undefined;
  }

  if (nextRunAt === undefined) {
    // once + wall clock: prefer explicit next slot; if that slot is within the
    // next 24h use computeNextRunAt; if already past today, still next match.
    nextRunAt = computeNextRunAt({
      frequency,
      time,
      weekdays,
      enabled,
    });
  }

  const input: AutomationInputDto = {
    title,
    prompt,
    enabled,
    frequency,
    time,
    weekdays,
    notify:
      typeof o.notify === "string" && o.notify.trim()
        ? String(o.notify).trim()
        : "all",
    projectId:
      o.projectId === null || o.projectId === undefined
        ? null
        : String(o.projectId),
    modelId:
      o.modelId === null || o.modelId === undefined
        ? null
        : String(o.modelId),
    effort:
      o.effort === null || o.effort === undefined ? null : String(o.effort),
    nextRunAt: nextRunAt ?? null,
  };
  return input;
}

/**
 * Strip automation fences from assistant text and parse the last valid config.
 * Prefer ```grok-automation; also accept ```json as fallback.
 */
export function extractAutomationPayload(text: string): ExtractedAutomation {
  if (!text) {
    return { cleanText: text, input: null, rawJson: null };
  }

  let input: AutomationInputDto | null = null;
  let rawJson: string | null = null;
  FENCE_RE.lastIndex = 0;
  const matches = [...text.matchAll(FENCE_RE)];

  for (const m of matches) {
    const body = (m[1] || "").trim();
    // Model sometimes wraps JSON in an extra code fence or adds trailing prose
    const jsonBody = body
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = parseAutomationConfigJson(jsonBody);
    if (parsed) {
      input = parsed;
      rawJson = jsonBody;
    }
  }

  FENCE_RE.lastIndex = 0;
  let cleanText = text.replace(FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!cleanText.trim() && input) {
    cleanText = "";
  }

  return { cleanText, input, rawJson };
}

/** True if text still contains an automation fence. */
export function hasAutomationFence(text: string): boolean {
  FENCE_RE.lastIndex = 0;
  return FENCE_RE.test(text);
}

/**
 * User explicitly rejects timers / scheduled tasks.
 * Hard stop for setup wrap and auto-apply.
 */
export function looksLikeScheduleReject(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  return (
    /禁止\s*(定时|排程|已安排|自动化|自動化|schedule|loop|scheduler)/i.test(t) ||
    /不要\s*(创建)?\s*(定时|排程|已安排|loop|scheduler|自动化|自動化)/i.test(t) ||
    /不是\s*(定时|排程|闹钟|鬧鐘)/i.test(t) ||
    /非\s*定时任务|非\s*排程任務/i.test(t) ||
    /\b(do not|don't|no)\s+(create\s+)?(a\s+)?(schedule|scheduled task|timer|loop|cron)\b/i.test(
      t,
    ) ||
    /\bnot a (scheduled|timer|cron)\b/i.test(t)
  );
}

/**
 * Clear clock / recurrence signals (not mere “later” product copy).
 */
export function hasExplicitScheduleSignal(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return (
    /定时|週期|周期|每隔|每天|每日|每周|每週|工作日|安排任务|安排任務|已安排|已排程|分钟后|分鐘後|小时后|小時後|每晚|早上\s*\d|下午\s*\d|晚上\s*\d|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点/.test(
      t,
    ) ||
    /\b(every day|daily|weekly|weekdays|schedule|remind me|in \d+\s*(min|mins|minute|minutes|hour|hours|sec|seconds)|every morning|every \d+\s*(min|hour|day)s?)\b/i.test(
      t,
    ) ||
    /过\s*\d+\s*分钟|過\s*\d+\s*分鐘|过\s*\d+\s*小时|過\s*\d+\s*小時|\d+\s*分钟后|\d+\s*分鐘後|\d+\s*小时后|\d+\s*小時後/.test(
      t,
    ) ||
    /明天\s*(\d|早上|上午|下午|晚上|提醒)|明天.*(跑|查|执行|執行|提醒)/.test(t) ||
    /\btomorrow\b/i.test(t)
  );
}

/**
 * Standing role / product-mode language that is often mis-routed into timers.
 * Alone (without a clear schedule signal) must not open automation setup.
 */
export function looksLikeStandingModeIntent(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return (
    /目标模式|目標模式|角色与模式|角色與模式|产品原则|產品原則|始终对齐|始終對齊|每次回复|每次回覆|会话原则|會話原則|北极星|北極星/.test(
      t,
    ) ||
    /\b(standing instruction|session rules?|from now on you)\b/i.test(t) ||
    /你是负责|你是負責/.test(t)
  );
}

/**
 * Heuristic: user is asking to schedule something (enter silent setup wrap).
 * Used when not already in explicit AI-create mode.
 */
export function looksLikeScheduleIntent(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (looksLikeScheduleReject(t)) return false;
  if (!hasExplicitScheduleSignal(t)) return false;
  // Long role cards that happen to mention “每天” in product copy still need a
  // real timer word; standing mode without timer language → not schedule.
  if (
    looksLikeStandingModeIntent(t) &&
    !/定时|每天|每日|每周|每週|每隔|分钟后|分鐘後|小时后|小時後|已安排|已排程|schedule|daily|weekly|remind|每\s*\d/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

export type RecentChatMessage = {
  role?: string;
  content?: string;
};

/** Newest-first scan of user bubbles, returned oldest→newest joined. */
export function recentUserPlainText(
  messages: RecentChatMessage[],
  maxUser = 3,
): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < maxUser; i--) {
    const m = messages[i];
    if (m?.role === "user" && (m.content || "").trim()) {
      parts.push(String(m.content));
    }
  }
  return parts.reverse().join("\n");
}

/**
 * Whether the shell should create an automation without asking.
 * - Explicit AI-create / setup session → yes (unless user rejected schedules).
 * - Recent user text looks like a real schedule → yes.
 * - Otherwise → no (confirm or skip); protects /goal and role cards.
 */
export function shouldAutoApplyAutomationFence(opts: {
  inExplicitAutomationSetup: boolean;
  recentUserText: string;
}): boolean {
  const recent = opts.recentUserText || "";
  if (looksLikeScheduleReject(recent)) return false;
  if (opts.inExplicitAutomationSetup) return true;
  return looksLikeScheduleIntent(recent);
}
