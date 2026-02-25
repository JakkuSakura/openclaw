import { Type } from "@sinclair/typebox";

export const SchedulerStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const SchedulerStatusResultSchema = Type.Object(
  {
    crontab: Type.Optional(Type.String()),
    systemdTimers: Type.Optional(Type.String()),
    systemdServices: Type.Optional(Type.String()),
    errors: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
