import { loadConfig } from "../../config/config.js";
import { runCrontabJob, shouldRunJob } from "../../cron/crontab-exec.js";
import { readCrontabRunHistory } from "../../cron/crontab-history.js";
import {
  applyCronJobPatch,
  createCronJobFromInput,
  readCrontabSnapshot,
  removeJobFromList,
  replaceJobInList,
  resolveCrontabJobOrThrow,
  resolveCrontabSchedule,
  writeCrontabJobs,
} from "../../cron/crontab-store.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function useCrontabSourceOfTruth() {
  const cfg = loadConfig();
  return cfg.cron?.enabled === false;
}

function validateCrontabScheduleOrThrow(schedule: CronJobCreate["schedule"]) {
  const result = resolveCrontabSchedule(schedule);
  if (!result.ok) {
    throw new Error(result.error);
  }
}

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context }) => {
    if (useCrontabSourceOfTruth()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake is not supported in crontab cron mode"),
      );
      return;
    }
    if (!validateWakeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
    };
    const result = context.cron.wake({ mode: p.mode, text: p.text });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context }) => {
    if (!validateCronListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      const p = params as {
        includeDisabled?: boolean;
        limit?: number;
        offset?: number;
        query?: string;
        enabled?: "all" | "enabled" | "disabled";
        sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
        sortDir?: "asc" | "desc";
      };
      const snapshot = await readCrontabSnapshot();
      const jobs = snapshot.jobs.filter((job) => {
        if (p.enabled === "enabled") {
          return job.enabled;
        }
        if (p.enabled === "disabled") {
          return !job.enabled;
        }
        if (!p.includeDisabled && !job.enabled) {
          return false;
        }
        if (p.query && !job.name.toLowerCase().includes(p.query.toLowerCase())) {
          return false;
        }
        return true;
      });
      const sortBy = p.sortBy ?? "nextRunAtMs";
      const sortDir = p.sortDir ?? "asc";
      const compare = (a: number | string, b: number | string) => (a === b ? 0 : a > b ? 1 : -1);
      jobs.sort((a, b) => {
        const sign = sortDir === "desc" ? -1 : 1;
        if (sortBy === "name") {
          return sign * compare(a.name.toLowerCase(), b.name.toLowerCase());
        }
        if (sortBy === "updatedAtMs") {
          return sign * compare(a.updatedAtMs ?? 0, b.updatedAtMs ?? 0);
        }
        return sign * compare(a.state?.nextRunAtMs ?? 0, b.state?.nextRunAtMs ?? 0);
      });
      const limit = p.limit ?? 50;
      const offset = p.offset ?? 0;
      const page = jobs.slice(offset, offset + limit);
      respond(true, { jobs: page, meta: { total: jobs.length, limit, offset } }, undefined);
      return;
    }

    const p = params as {
      includeDisabled?: boolean;
      limit?: number;
      offset?: number;
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
    };
    const page = await context.cron.listPage({
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!validateCronStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      const snapshot = await readCrontabSnapshot();
      respond(true, { enabled: snapshot.jobs.length > 0, jobs: snapshot.jobs.length }, undefined);
      return;
    }

    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.add": async ({ params, respond, context }) => {
    const normalized = normalizeCronJobCreate(params) ?? params;
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      try {
        validateCrontabScheduleOrThrow(jobCreate.schedule);
        const snapshot = await readCrontabSnapshot();
        const job = createCronJobFromInput(jobCreate);
        const nextJobs = [...snapshot.jobs, job];
        await writeCrontabJobs(nextJobs, snapshot.lines);
        respond(true, job, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(err)));
      }
      return;
    }

    const job = await context.cron.add(jobCreate);
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context }) => {
    const normalizedPatch = normalizeCronJobPatch((params as { patch?: unknown } | null)?.patch);
    const candidate =
      normalizedPatch && typeof params === "object" && params !== null
        ? { ...params, patch: normalizedPatch }
        : params;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
      if (useCrontabSourceOfTruth()) {
        try {
          validateCrontabScheduleOrThrow(patch.schedule);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
          return;
        }
      }
    }

    if (useCrontabSourceOfTruth()) {
      try {
        const snapshot = await readCrontabSnapshot();
        const prevJob = resolveCrontabJobOrThrow(snapshot.jobs, jobId);
        const nextJob = applyCronJobPatch(prevJob, patch);
        const nextJobs = replaceJobInList(snapshot.jobs, nextJob);
        await writeCrontabJobs(nextJobs, snapshot.lines);
        respond(true, nextJob, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(err)));
      }
      return;
    }

    const job = await context.cron.update(jobId, patch);
    respond(true, job, undefined);
  },
  "cron.remove": async ({ params, respond, context }) => {
    if (!validateCronRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      try {
        const snapshot = await readCrontabSnapshot();
        const nextJobs = removeJobFromList(snapshot.jobs, jobId);
        await writeCrontabJobs(nextJobs, snapshot.lines);
        respond(true, { ok: true, removed: true }, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(err)));
      }
      return;
    }

    const result = await context.cron.remove(jobId);
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context }) => {
    if (!validateCronRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; mode?: "due" | "force" };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      const mode = p.mode ?? "force";
      try {
        const snapshot = await readCrontabSnapshot();
        const job = resolveCrontabJobOrThrow(snapshot.jobs, jobId);
        if (!shouldRunJob(job, mode)) {
          respond(true, { ok: true, ran: false, reason: "not-due" }, undefined);
          return;
        }
        const result = await runCrontabJob({
          cfg: loadConfig(),
          deps: context.deps,
          job,
          mode,
        });
        if (!result.ok) {
          respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, result.error));
          return;
        }
        if (job.schedule.kind === "at" && job.deleteAfterRun === true && result.ran) {
          const nextJobs = removeJobFromList(snapshot.jobs, jobId);
          await writeCrontabJobs(nextJobs, snapshot.lines);
        }
        respond(true, result, undefined);
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, String(err)));
      }
      return;
    }

    const result = await context.cron.run(jobId, p.mode ?? "force");
    respond(true, result, undefined);
  },
  "cron.runs": async ({ params, respond, context }) => {
    if (!validateCronRunsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
        ),
      );
      return;
    }

    if (useCrontabSourceOfTruth()) {
      const p = params as { id?: string; jobId?: string; limit?: number };
      const jobId = p.id ?? p.jobId;
      if (!jobId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
        );
        return;
      }
      const limit = typeof p.limit === "number" && Number.isFinite(p.limit) ? p.limit : 50;
      const entries = await readCrontabRunHistory({ jobId, limit });
      respond(
        true,
        { entries, total: entries.length, hasMore: false, nextOffset: null },
        undefined,
      );
      return;
    }

    const p = params as {
      id?: string;
      jobId?: string;
      limit?: number;
      offset?: number;
      scope?: string;
    };
    const jobId = p.id ?? p.jobId;
    if (p.scope === "all") {
      const page = await readCronRunLogEntriesPageAll({
        storePath: context.cronStorePath,
        offset: p.offset,
        limit: p.limit,
      });
      respond(true, page, undefined);
      return;
    }
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
      );
      return;
    }
    const jobs = await context.cron.list({ includeDisabled: true });
    const job = jobs.find((entry) => entry.id === jobId);
    if (!job) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"),
      );
      return;
    }
    const page = await readCronRunLogEntriesPage({
      storePath: context.cronStorePath,
      logPath: resolveCronRunLogPath(context.cronStorePath, jobId),
      jobId,
      jobName: job.name,
      limit: p.limit,
      offset: p.offset,
    });
    respond(true, page, undefined);
  },
};
