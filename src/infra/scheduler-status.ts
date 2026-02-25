import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SchedulerStatus = {
  crontab?: string;
  systemdTimers?: string;
  systemdServices?: string;
  errors?: string[];
};

async function runCommand(command: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), ok: true };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      stdout: (error.stdout ?? "").toString().trimEnd(),
      stderr: (error.stderr ?? error.message ?? "").toString().trimEnd(),
      ok: false,
      code: error.code,
    } as const;
  }
}

export async function readSchedulerStatus(): Promise<SchedulerStatus> {
  const errors: string[] = [];
  let crontab = "";
  let systemdTimers: string | undefined;
  let systemdServices: string | undefined;

  const cronResult = await runCommand("crontab", ["-l"]);
  if (cronResult.ok) {
    crontab = cronResult.stdout;
  } else if (cronResult.stderr.toLowerCase().includes("no crontab")) {
    crontab = "";
  } else {
    errors.push(`crontab: ${cronResult.stderr || "failed to read"}`);
  }

  const timersResult = await runCommand("systemctl", [
    "--user",
    "list-timers",
    "--all",
    "--no-legend",
    "--no-pager",
  ]);
  if (timersResult.ok) {
    systemdTimers = timersResult.stdout;
  } else {
    errors.push(`systemd timers: ${timersResult.stderr || "failed to read"}`);
  }

  const servicesResult = await runCommand("systemctl", [
    "--user",
    "list-units",
    "--type=service",
    "--state=running",
    "--no-legend",
    "--no-pager",
  ]);
  if (servicesResult.ok) {
    systemdServices = servicesResult.stdout;
  } else {
    errors.push(`systemd services: ${servicesResult.stderr || "failed to read"}`);
  }

  return {
    crontab,
    systemdTimers,
    systemdServices,
    errors: errors.length ? errors : undefined,
  };
}
