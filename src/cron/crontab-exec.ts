import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { computeJobNextRunAtMs, isJobDue } from "./service/jobs.js";
import type { CronJob, CronRunOutcome } from "./types.js";
import { normalizeHttpWebhookUrl } from "./webhook-url.js";

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

export type CrontabRunResult =
  | { ok: true; ran: false; reason: "not-due" | "already-running" }
  | { ok: true; ran: true; outcome: CronRunOutcome; nextRunAtMs?: number | undefined }
  | { ok: false; error: string };

export function resolveJobNextRun(job: CronJob, nowMs: number) {
  if (!job.enabled) {
    return undefined;
  }
  return computeJobNextRunAtMs(job, nowMs);
}

export function shouldRunJob(job: CronJob, mode: "due" | "force") {
  if (mode === "force") {
    return true;
  }
  return isJobDue(job, Date.now(), { forced: false });
}

async function deliverWebhook(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  outcome: CronRunOutcome;
}) {
  if (params.job.delivery?.mode !== "webhook") {
    return { delivered: false, error: undefined };
  }
  const url = normalizeHttpWebhookUrl(params.job.delivery.to);
  if (!url) {
    return { delivered: false, error: "invalid webhook url" };
  }
  const body = {
    jobId: params.job.id,
    name: params.job.name,
    status: params.outcome.status,
    summary: params.outcome.summary,
    error: params.outcome.error,
    sessionId: params.outcome.sessionId,
    sessionKey: params.outcome.sessionKey,
  };
  const headers = new Headers({ "content-type": "application/json" });
  const token = params.cfg.cron?.webhookToken?.trim();
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  try {
    const res = await fetchWithSsrFGuard(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      timeoutMs: CRON_WEBHOOK_TIMEOUT_MS,
    });
    return { delivered: res.ok, error: res.ok ? undefined : `webhook failed: ${res.status}` };
  } catch (err) {
    return { delivered: false, error: String(err) };
  }
}

export async function runCrontabJob(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronJob;
  mode: "due" | "force";
}): Promise<CrontabRunResult> {
  if (!shouldRunJob(params.job, params.mode)) {
    return { ok: true, ran: false, reason: "not-due" };
  }

  if (params.job.sessionTarget === "main") {
    if (params.job.payload.kind !== "systemEvent") {
      return { ok: false, error: "main session jobs require systemEvent payload" };
    }
    const agentId = params.job.agentId ?? resolveDefaultAgentId(params.cfg);
    const sessionKey =
      params.job.sessionKey ?? resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
    enqueueSystemEvent(params.job.payload.text, { sessionKey });
    if (params.job.wakeMode === "now" || params.job.wakeMode === "next-heartbeat") {
      requestHeartbeatNow({ reason: "cron", agentId, sessionKey });
    }
    const outcome: CronRunOutcome = { status: "ok", sessionKey };
    const webhook = await deliverWebhook({ cfg: params.cfg, job: params.job, outcome });
    if (webhook.error && params.job.delivery?.bestEffort !== true) {
      outcome.status = "error";
      outcome.error = webhook.error;
      outcome.errorKind = "delivery-target";
    }
    const nextRunAtMs = resolveJobNextRun(params.job, Date.now());
    return { ok: true, ran: true, outcome, nextRunAtMs };
  }

  if (params.job.payload.kind !== "agentTurn") {
    return { ok: false, error: "isolated jobs require agentTurn payload" };
  }

  const result = await runCronIsolatedAgentTurn({
    cfg: params.cfg,
    deps: params.deps,
    job: params.job,
    message: params.job.payload.message,
    abortSignal: undefined,
  });

  const outcome: CronRunOutcome = {
    status: result.status ?? "ok",
    error: result.error,
    summary: result.summary,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
  };

  const webhook = await deliverWebhook({ cfg: params.cfg, job: params.job, outcome });
  if (webhook.error && params.job.delivery?.bestEffort !== true) {
    outcome.status = "error";
    outcome.error = webhook.error;
    outcome.errorKind = "delivery-target";
  }

  const nextRunAtMs = resolveJobNextRun(params.job, Date.now());
  return { ok: true, ran: true, outcome, nextRunAtMs };
}
