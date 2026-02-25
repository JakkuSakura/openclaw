import { spawn } from "node:child_process";
import type { CronJob, CronSchedule } from "./types.js";

const OPENCLAW_BLOCK_START = "# openclaw:cron begin";
const OPENCLAW_BLOCK_END = "# openclaw:cron end";
const OPENCLAW_ENTRY_TAG = "# openclaw:cron";

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const RUN_CMD_PREFIX = "openclaw cron run";

export type CrontabScheduleResult =
  | { ok: true; expr: string; tz?: string }
  | { ok: false; error: string };

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

function stripManagedBlock(lines: string[]) {
  const startIndex = lines.findIndex((line) => line.trim() === OPENCLAW_BLOCK_START);
  if (startIndex === -1) {
    return lines.slice();
  }
  const endIndex = lines.findIndex(
    (line, idx) => idx > startIndex && line.trim() === OPENCLAW_BLOCK_END,
  );
  if (endIndex === -1) {
    return lines.slice(0, startIndex);
  }
  return [...lines.slice(0, startIndex), ...lines.slice(endIndex + 1)];
}

function sanitizeInline(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/[#\r\n]/g, " ")
    .trim();
}

function formatCrontabCommand(jobId: string) {
  return `${RUN_CMD_PREFIX} ${jobId}`;
}

function buildManagedBlock(jobs: CronJob[]) {
  const lines: string[] = [];
  lines.push(OPENCLAW_BLOCK_START);
  if (!jobs.length) {
    lines.push("# (no cron jobs)");
    lines.push(OPENCLAW_BLOCK_END);
    return lines;
  }

  for (const job of jobs) {
    const scheduleResult = resolveCrontabSchedule(job.schedule);
    if (!scheduleResult.ok) {
      throw new Error(`job ${job.id}: ${scheduleResult.error}`);
    }
    const displayName = sanitizeInline(job.name || job.id);
    lines.push(`${OPENCLAW_ENTRY_TAG} job ${job.id} ${displayName}`.trim());
    if (scheduleResult.tz) {
      lines.push(`CRON_TZ=${scheduleResult.tz}`);
    }
    const entry =
      `${scheduleResult.expr} ${formatCrontabCommand(job.id)} ${OPENCLAW_ENTRY_TAG}`.trim();
    lines.push(job.enabled ? entry : `# ${entry}`);
    if (scheduleResult.tz) {
      lines.push("CRON_TZ=");
    }
  }

  lines.push(OPENCLAW_BLOCK_END);
  return lines;
}

export function resolveCrontabSchedule(schedule: CronSchedule): CrontabScheduleResult {
  if (schedule.kind === "cron") {
    const expr = String(schedule.expr ?? "").trim();
    if (!expr) {
      return { ok: false, error: "cron expression is required" };
    }
    const parts = expr.split(/\s+/).filter(Boolean);
    if (parts.length === 6) {
      return { ok: false, error: "crontab does not support 6-field cron (seconds)" };
    }
    if (parts.length !== 5) {
      return { ok: false, error: "crontab requires a 5-field cron expression" };
    }
    if (schedule.tz) {
      return { ok: false, error: "crontab scheduler does not support per-job timezones" };
    }
    if (typeof schedule.staggerMs === "number" && schedule.staggerMs > 0) {
      return { ok: false, error: "crontab scheduler does not support stagger" };
    }
    return { ok: true, expr };
  }

  if (schedule.kind === "every") {
    const everyMs = Number(schedule.everyMs);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      return { ok: false, error: "every schedule requires a positive interval" };
    }
    if (schedule.anchorMs !== undefined) {
      return { ok: false, error: "crontab scheduler does not support anchored intervals" };
    }
    if (everyMs % ONE_MINUTE_MS !== 0) {
      return { ok: false, error: "crontab scheduler supports 1-minute granularity" };
    }
    const minutes = Math.floor(everyMs / ONE_MINUTE_MS);
    if (minutes <= 0) {
      return { ok: false, error: "every schedule must be at least 1 minute" };
    }
    if (minutes < 60 && 60 % minutes === 0) {
      return { ok: true, expr: `*/${minutes} * * * *` };
    }
    const hours = everyMs / ONE_HOUR_MS;
    if (Number.isInteger(hours) && hours > 0 && 24 % hours === 0) {
      return { ok: true, expr: `0 */${hours} * * *` };
    }
    const days = everyMs / ONE_DAY_MS;
    if (Number.isInteger(days) && days > 0 && days <= 31) {
      return { ok: true, expr: `0 0 */${days} * *` };
    }
    return { ok: false, error: "every schedule interval is not representable in crontab" };
  }

  if (schedule.kind === "at") {
    const raw = String(schedule.at ?? "").trim();
    const when = raw ? new Date(raw) : null;
    if (!when || Number.isNaN(when.getTime())) {
      return { ok: false, error: "invalid schedule.at timestamp" };
    }
    const adjusted = new Date(when.getTime());
    if (adjusted.getSeconds() > 0 || adjusted.getMilliseconds() > 0) {
      adjusted.setMinutes(adjusted.getMinutes() + 1, 0, 0);
    }
    const minute = adjusted.getMinutes();
    const hour = adjusted.getHours();
    const day = adjusted.getDate();
    const month = adjusted.getMonth() + 1;
    return { ok: true, expr: `${minute} ${hour} ${day} ${month} *` };
  }

  return { ok: false, error: "unsupported schedule kind" };
}

export async function syncCrontabForJobs(jobs: CronJob[]) {
  const listResult = await runCommand("crontab", ["-l"]);
  let lines: string[] = [];
  if (listResult.ok) {
    lines = listResult.stdout.split("\n");
  } else if (listResult.stderr.toLowerCase().includes("no crontab")) {
    lines = [];
  } else {
    throw new Error(`crontab -l failed: ${listResult.stderr || "unknown error"}`);
  }

  const unmanaged = stripManagedBlock(lines);
  const managedBlock = buildManagedBlock(jobs);
  const nextLines = [...unmanaged.filter((line) => line.trim() !== ""), "", ...managedBlock, ""];
  const content = nextLines.join("\n").replace(/\n{3,}/g, "\n\n");

  const writeResult = await runCommand("crontab", ["-"], content);
  if (!writeResult.ok) {
    throw new Error(`crontab - failed: ${writeResult.stderr || "unknown error"}`);
  }
}
