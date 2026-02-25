import type { GatewayRequestHandlers } from "./types.js";
import { readSchedulerStatus } from "../infra/scheduler-status.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSchedulerStatusParams,
} from "../protocol/index.js";

export const schedulerHandlers: GatewayRequestHandlers = {
  "scheduler.status": async ({ params, respond }) => {
    if (!validateSchedulerStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid scheduler.status params: ${formatValidationErrors(
            validateSchedulerStatusParams.errors,
          )}`,
        ),
      );
      return;
    }
    const status = await readSchedulerStatus();
    respond(true, status, undefined);
  },
};
