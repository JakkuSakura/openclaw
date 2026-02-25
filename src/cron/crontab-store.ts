import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronSchedule } from "./types.js";

const TAG = "openclaw:cron";
const TAG_PREFIX = `# ${TAG}`;
const CRON_COMMAND = "openclaw cron run";

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export type CrontabSnapshot = {
  lines: string[];
  jobs: CronJob[];
  errors: string[];
};

type ParsedTaggedEntry = {
  id: string;
  meta: Record<string, string>;
  scheduleLine?: string;
  scheduleDisabled?: boolean;
  scheduleExpr?: string;
  scheduleTz?: string;
  scheduleIndex?: number;
};

function runCommand(command: string, args: string[], input?: string) {
  return new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code?: number | null;
  }>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({ ok: false, stdout: "", stderr: String(err) });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    });

    if (typeof input === "string") {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

function encodeValue(value: string) {
  return encodeURIComponent(value);
}

function decodeValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseKeyValueTokens(text: string) {
  const out: Record<string, string> = {};
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = token.slice(0, eq).trim();
    const rawValue = token.slice(eq + 1).trim();
    if (!key) {
      continue;
    }
    out[key] = decodeValue(rawValue);
  }
  return out;
}

function parseTaggedLine(line: string) {
  const markerIndex = line.indexOf(TAG_PREFIX);
  if (markerIndex === -1) {
    return null;
  }
  const payload = line.slice(markerIndex + TAG_PREFIX.length).trim();
  return parseKeyValueTokens(payload);
}

function findTaggedEntries(lines: string[]) {
  const entries = new Map<string, ParsedTaggedEntry>();
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line.includes(TAG_PREFIX)) {
      continue;
    }
    const meta = parseTaggedLine(rawLine);
    if (!meta?.id) {
      errors.push(`Tagged cron line missing id: ${rawLine}`);
      continue;
    }
    const id = meta.id;
    const entry = entries.get(id) ?? { id, meta: {} };
    entry.meta = { ...entry.meta, ...meta };

    const scheduleInfo = parseScheduleLine(rawLine);
    if (scheduleInfo) {
      entry.scheduleLine = rawLine;
      entry.scheduleIndex = i;
      entry.scheduleDisabled = scheduleInfo.disabled;
      entry.scheduleExpr = scheduleInfo.expr;
    }

    entries.set(id, entry);
  }

  // Detect CRON_TZ line immediately before schedule line.
  for (const entry of entries.values()) {
    if (entry.scheduleIndex == null || entry.scheduleIndex <= 0) {
      continue;
    }
    const prevLine = lines[entry.scheduleIndex - 1].trim();
    if (prevLine.startsWith("CRON_TZ=")) {
      entry.scheduleTz = prevLine.slice("CRON_TZ=".length).trim() || undefined;
    }
  }

  return { entries, errors };
}

function parseScheduleLine(rawLine: string) {
  const trimmed = rawLine.trimStart();
  const disabled = trimmed.startsWith("#");
  const line = disabled ? trimmed.replace(/^#\s*/, "") : trimmed;
  if (!line.includes(TAG)) {
    return null;
  }
  if (!line.includes(CRON_COMMAND)) {
    return null;
  }
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 7) {
    return null;
  }
  const expr = parts.slice(0, 5).join(" ");
  return { expr, disabled };
}

function buildJobFromEntry(entry: ParsedTaggedEntry): CronJob | null {
  const meta = entry.meta;
  const id = meta.id?.trim();
  if (!id) {
    return null;
  }

  const schedule = resolveSchedule(meta, entry);
  if (!schedule) {
    return null;
  }

  const payloadKind = meta.payload_kind ?? "systemEvent";
  const payload =
    payloadKind === "agentTurn"
      ? {
          kind: "agentTurn" as const,
          message: meta.payload_message ?? "",
          model: meta.payload_model || undefined,
          thinking: meta.payload_thinking || undefined,
          timeoutSeconds: meta.payload_timeout_seconds
            ? Number.parseInt(meta.payload_timeout_seconds, 10)
            : undefined,
          allowUnsafeExternalContent:
            meta.payload_allow_unsafe_external_content === "true" ? true : undefined,
          deliver: meta.payload_deliver === "true" ? true : undefined,
          channel: meta.payload_channel || undefined,
          to: meta.payload_to || undefined,
          bestEffortDeliver: meta.payload_best_effort_deliver === "true" ? true : undefined,
        }
      : {
          kind: "systemEvent" as const,
          text: meta.payload_text ?? meta.payload_message ?? "",
        };

  const deliveryMode = meta.delivery_mode ?? "none";
  const delivery =
    deliveryMode === "none"
      ? undefined
      : {
          mode: deliveryMode as "none" | "announce" | "webhook",
          channel: meta.delivery_channel || undefined,
          to: meta.delivery_to || undefined,
          bestEffort: meta.delivery_best_effort === "true" ? true : undefined,
        };

  const enabled = entry.scheduleDisabled ? false : meta.enabled !== "false";

  const job: CronJob = {
    id,
    agentId: meta.agent_id || undefined,
    sessionKey: meta.session_key || undefined,
    name: meta.name ?? id,
    description: meta.description || undefined,
    enabled,
    deleteAfterRun: meta.delete_after_run === "true" ? true : undefined,
    createdAtMs: Number.parseInt(meta.created_at_ms ?? "0", 10) || Date.now(),
    updatedAtMs: Number.parseInt(meta.updated_at_ms ?? "0", 10) || Date.now(),
    schedule,
    sessionTarget: (meta.session_target as "main" | "isolated") ?? "main",
    wakeMode: (meta.wake_mode as "now" | "next-heartbeat") ?? "now",
    payload,
    delivery,
    state: {},
  };
  if (job.enabled) {
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, Date.now());
  }
  return job;
}

function resolveSchedule(
  meta: Record<string, string>,
  entry: ParsedTaggedEntry,
): CronSchedule | null {
  const kind = meta.schedule_kind ?? "cron";
  if (kind === "at") {
    const at = meta.schedule_at ?? "";
    if (!at) {
      return null;
    }
    return { kind: "at", at };
  }
  if (kind === "every") {
    const raw = meta.schedule_every_ms ?? "";
    const everyMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      return null;
    }
    return {
      kind: "every",
      everyMs,
      anchorMs: meta.schedule_anchor_ms ? Number.parseInt(meta.schedule_anchor_ms, 10) : undefined,
    };
  }

  const expr = meta.schedule_expr ?? entry.scheduleExpr ?? "";
  if (!expr) {
    return null;
  }
  return {
    kind: "cron",
    expr,
    tz: meta.schedule_tz || entry.scheduleTz || undefined,
    staggerMs: meta.schedule_stagger_ms ? Number.parseInt(meta.schedule_stagger_ms, 10) : undefined,
  };
}

export async function readCrontabSnapshot(): Promise<CrontabSnapshot> {
  const listResult = await runCommand("crontab", ["-l"]);
  let lines: string[] = [];
  const errors: string[] = [];

  if (listResult.ok) {
    lines = listResult.stdout ? listResult.stdout.split("\n") : [];
  } else if (listResult.stderr.toLowerCase().includes("no crontab")) {
    lines = [];
  } else {
    errors.push(`crontab: ${listResult.stderr || "failed to read"}`);
    lines = [];
  }

  const { entries, errors: parseErrors } = findTaggedEntries(lines);
  errors.push(...parseErrors);
  const jobs = Array.from(entries.values())
    .map((entry) => buildJobFromEntry(entry))
    .filter((job): job is CronJob => Boolean(job));

  return { lines, jobs, errors };
}

export async function writeCrontabJobs(jobs: CronJob[], existingLines: string[]) {
  const filtered = existingLines.filter(
    (line) => !line.includes(TAG_PREFIX) && !line.includes(TAG),
  );
  const entries = jobs.flatMap((job) => buildTaggedEntryLines(job));
  const nextLines = [...filtered, ...(filtered.length ? [""] : []), ...entries, ""];
  const content = nextLines.join("\n").replace(/\n{3,}/g, "\n\n");

  const writeResult = await runCommand("crontab", ["-"], content);
  if (!writeResult.ok) {
    throw new Error(`crontab - failed: ${writeResult.stderr || "unknown error"}`);
  }
}

export function createCronJobFromInput(input: CronJobCreate): CronJob {
  const now = Date.now();
  return {
    id: randomUUID(),
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    name: input.name,
    description: input.description,
    enabled: input.enabled ?? true,
    deleteAfterRun: input.deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: input.schedule,
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload: input.payload,
    delivery: input.delivery,
    state: {},
  };
}

export function applyCronJobPatch(job: CronJob, patch: CronJobPatch): CronJob {
  const next: CronJob = {
    ...job,
    ...patch,
    payload: patch.payload
      ? ({ ...job.payload, ...patch.payload } as CronJob["payload"])
      : job.payload,
    delivery: patch.delivery
      ? ({ ...job.delivery, ...patch.delivery } as CronJob["delivery"])
      : job.delivery,
    state: patch.state ? { ...job.state, ...patch.state } : job.state,
    updatedAtMs: Date.now(),
  };
  if (patch.schedule) {
    next.schedule = patch.schedule;
  }
  return next;
}

export function resolveCrontabSchedule(schedule: CronSchedule) {
  if (schedule.kind === "cron") {
    const expr = String(schedule.expr ?? "").trim();
    if (!expr) {
      return { ok: false, error: "cron expression is required" } as const;
    }
    const parts = expr.split(/\s+/).filter(Boolean);
    if (parts.length === 6) {
      return { ok: false, error: "crontab does not support 6-field cron (seconds)" } as const;
    }
    if (parts.length !== 5) {
      return { ok: false, error: "crontab requires a 5-field cron expression" } as const;
    }
    if (schedule.tz) {
      return { ok: false, error: "crontab scheduler does not support per-job timezones" } as const;
    }
    if (typeof schedule.staggerMs === "number" && schedule.staggerMs > 0) {
      return { ok: false, error: "crontab scheduler does not support stagger" } as const;
    }
    return { ok: true, expr } as const;
  }

  if (schedule.kind === "every") {
    const everyMs = Number(schedule.everyMs);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      return { ok: false, error: "every schedule requires a positive interval" } as const;
    }
    if (schedule.anchorMs !== undefined) {
      return { ok: false, error: "crontab scheduler does not support anchored intervals" } as const;
    }
    if (everyMs % ONE_MINUTE_MS !== 0) {
      return { ok: false, error: "crontab scheduler supports 1-minute granularity" } as const;
    }
    const minutes = Math.floor(everyMs / ONE_MINUTE_MS);
    if (minutes <= 0) {
      return { ok: false, error: "every schedule must be at least 1 minute" } as const;
    }
    if (minutes < 60 && 60 % minutes === 0) {
      return { ok: true, expr: `*/${minutes} * * * *` } as const;
    }
    const hours = everyMs / ONE_HOUR_MS;
    if (Number.isInteger(hours) && hours > 0 && 24 % hours === 0) {
      return { ok: true, expr: `0 */${hours} * * *` } as const;
    }
    const days = everyMs / ONE_DAY_MS;
    if (Number.isInteger(days) && days > 0 && days <= 31) {
      return { ok: true, expr: `0 0 */${days} * *` } as const;
    }
    return { ok: false, error: "every schedule interval is not representable in crontab" } as const;
  }

  if (schedule.kind === "at") {
    const raw = String(schedule.at ?? "").trim();
    const when = raw ? new Date(raw) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return { ok: false, error: "invalid schedule.at timestamp" } as const;
    }
    const adjusted = new Date(when.getTime());
    if (adjusted.getSeconds() > 0 || adjusted.getMilliseconds() > 0) {
      adjusted.setMinutes(adjusted.getMinutes() + 1, 0, 0);
    }
    const minute = adjusted.getMinutes();
    const hour = adjusted.getHours();
    const day = adjusted.getDate();
    const month = adjusted.getMonth() + 1;
    return { ok: true, expr: `${minute} ${hour} ${day} ${month} *` } as const;
  }

  return { ok: false, error: "unsupported schedule kind" } as const;
}

function buildTaggedEntryLines(job: CronJob) {
  const lines: string[] = [];
  const base: Record<string, string> = {
    id: job.id,
    name: job.name,
    enabled: job.enabled ? "true" : "false",
    session_target: job.sessionTarget,
    wake_mode: job.wakeMode,
    created_at_ms: String(job.createdAtMs),
    updated_at_ms: String(job.updatedAtMs),
  };
  if (job.description) {
    base.description = job.description;
  }
  if (job.agentId) {
    base.agent_id = job.agentId;
  }
  if (job.sessionKey) {
    base.session_key = job.sessionKey;
  }
  if (job.deleteAfterRun !== undefined) {
    base.delete_after_run = job.deleteAfterRun ? "true" : "false";
  }

  lines.push(buildTaggedLine(base));

  if (job.payload.kind === "agentTurn") {
    const payload: Record<string, string> = {
      id: job.id,
      payload_kind: "agentTurn",
      payload_message: job.payload.message,
    };
    if (job.payload.model) {
      payload.payload_model = job.payload.model;
    }
    if (job.payload.thinking) {
      payload.payload_thinking = job.payload.thinking;
    }
    if (job.payload.timeoutSeconds !== undefined) {
      payload.payload_timeout_seconds = String(job.payload.timeoutSeconds);
    }
    if (job.payload.allowUnsafeExternalContent !== undefined) {
      payload.payload_allow_unsafe_external_content = job.payload.allowUnsafeExternalContent
        ? "true"
        : "false";
    }
    if (job.payload.deliver !== undefined) {
      payload.payload_deliver = job.payload.deliver ? "true" : "false";
    }
    if (job.payload.channel) {
      payload.payload_channel = job.payload.channel;
    }
    if (job.payload.to) {
      payload.payload_to = job.payload.to;
    }
    if (job.payload.bestEffortDeliver !== undefined) {
      payload.payload_best_effort_deliver = job.payload.bestEffortDeliver ? "true" : "false";
    }
    lines.push(buildTaggedLine(payload));
  } else {
    const payload: Record<string, string> = {
      id: job.id,
      payload_kind: "systemEvent",
      payload_text: job.payload.text,
    };
    lines.push(buildTaggedLine(payload));
  }

  if (job.delivery && job.delivery.mode !== "none") {
    const delivery: Record<string, string> = {
      id: job.id,
      delivery_mode: job.delivery.mode,
    };
    if (job.delivery.channel) {
      delivery.delivery_channel = job.delivery.channel;
    }
    if (job.delivery.to) {
      delivery.delivery_to = job.delivery.to;
    }
    if (job.delivery.bestEffort !== undefined) {
      delivery.delivery_best_effort = job.delivery.bestEffort ? "true" : "false";
    }
    lines.push(buildTaggedLine(delivery));
  }

  const scheduleMeta: Record<string, string> = {
    id: job.id,
    schedule_kind: job.schedule.kind,
  };
  if (job.schedule.kind === "at") {
    scheduleMeta.schedule_at = job.schedule.at;
  } else if (job.schedule.kind === "every") {
    scheduleMeta.schedule_every_ms = String(job.schedule.everyMs);
    if (job.schedule.anchorMs !== undefined) {
      scheduleMeta.schedule_anchor_ms = String(job.schedule.anchorMs);
    }
  } else {
    scheduleMeta.schedule_expr = job.schedule.expr;
    if (job.schedule.tz) {
      scheduleMeta.schedule_tz = job.schedule.tz;
    }
    if (job.schedule.staggerMs !== undefined) {
      scheduleMeta.schedule_stagger_ms = String(job.schedule.staggerMs);
    }
  }
  lines.push(buildTaggedLine(scheduleMeta));

  const cronExprResult = resolveCrontabSchedule(job.schedule);
  if (!cronExprResult.ok) {
    throw new Error(`job ${job.id}: ${cronExprResult.error}`);
  }
  const cronExpr = cronExprResult.expr;

  if (job.schedule.kind === "cron" && job.schedule.tz) {
    lines.push(`CRON_TZ=${job.schedule.tz}`);
  }
  const scheduleLine = `${cronExpr} ${CRON_COMMAND} ${job.id} ${TAG_PREFIX} id=${encodeValue(job.id)}`;
  lines.push(job.enabled ? scheduleLine : `# ${scheduleLine}`);
  if (job.schedule.kind === "cron" && job.schedule.tz) {
    lines.push("CRON_TZ=");
  }

  return lines;
}

function buildTaggedLine(values: Record<string, string>) {
  const parts = Object.entries(values)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${encodeValue(String(value))}`);
  return `${TAG_PREFIX} ${parts.join(" ")}`.trim();
}

export function resolveCrontabJobOrThrow(jobs: CronJob[], id: string) {
  const job = jobs.find((entry) => entry.id === id);
  if (!job) {
    throw new Error(`cron job not found: ${id}`);
  }
  return job;
}

export function replaceJobInList(jobs: CronJob[], job: CronJob) {
  const next = jobs.filter((entry) => entry.id !== job.id);
  next.push(job);
  return next;
}

export function removeJobFromList(jobs: CronJob[], id: string) {
  return jobs.filter((entry) => entry.id !== id);
}
