import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { CronRunLogEntry } from "./types.js";

const COMMAND_MARKER = "openclaw cron run";

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: string[]) {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ ok: code === 0, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });
  });
}

function parseJournalTimestamp(line: string) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (!match) {
    return Date.now();
  }
  const parsed = Date.parse(match[1].replace(" ", "T") + "Z");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function parseRunEntry(line: string, jobId: string) {
  if (!line.includes(COMMAND_MARKER)) {
    return null;
  }
  if (!line.includes(jobId)) {
    return null;
  }
  const ts = parseJournalTimestamp(line);
  const status = line.toLowerCase().includes("error") ? "error" : "ok";
  return {
    ts,
    jobId,
    status,
  } satisfies CronRunLogEntry;
}

async function readJournalLines() {
  const unitCandidates = ["cron.service", "crond.service"];
  for (const unit of unitCandidates) {
    const res = await runCommand("journalctl", ["-u", unit, "--no-pager", "-o", "short-iso"]);
    if (res.ok && res.stdout) {
      const lines = res.stdout.split("\n");
      return lines;
    }
  }
  return [] as string[];
}

async function readSyslogLines() {
  const candidates = ["/var/log/cron", "/var/log/syslog"];
  for (const path of candidates) {
    try {
      const content = await fs.readFile(path, "utf8");
      if (content.trim()) {
        return content.split("\n");
      }
    } catch {
      // ignore
    }
  }
  return [] as string[];
}

export async function readCrontabRunHistory(params: {
  jobId: string;
  limit: number;
}): Promise<CronRunLogEntry[]> {
  const lines = (await readJournalLines()).length
    ? await readJournalLines()
    : await readSyslogLines();

  const entries: CronRunLogEntry[] = [];
  for (const line of lines.toReversed()) {
    const parsed = parseRunEntry(line, params.jobId);
    if (!parsed) {
      continue;
    }
    entries.push(parsed);
    if (entries.length >= params.limit) {
      break;
    }
  }
  return entries;
}
