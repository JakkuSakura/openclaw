import type { GatewayBrowserClient } from "../gateway.ts";
import type { SchedulerStatus } from "../types.ts";

export type SchedulerState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  schedulerStatus: SchedulerStatus | null;
  schedulerError: string | null;
};

export async function loadSchedulerStatus(state: SchedulerState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<SchedulerStatus>("scheduler.status", {});
    state.schedulerStatus = res;
  } catch (err) {
    state.schedulerError = String(err);
  }
}
