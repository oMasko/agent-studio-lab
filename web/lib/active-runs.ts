type ActiveRun = {
  controller: AbortController;
  startedAt: number;
};

const state = globalThis as typeof globalThis & {
  __agentStudioActiveRuns?: Map<string, ActiveRun>;
};

function activeRuns(): Map<string, ActiveRun> {
  state.__agentStudioActiveRuns ??= new Map();
  return state.__agentStudioActiveRuns;
}

export function registerActiveRun(runId: string): AbortController {
  const previous = activeRuns().get(runId);
  if (previous) previous.controller.abort("Agent Run 被新的执行实例替换");
  const controller = new AbortController();
  activeRuns().set(runId, { controller, startedAt: Date.now() });
  return controller;
}

export function releaseActiveRun(runId: string, controller: AbortController): void {
  if (activeRuns().get(runId)?.controller === controller) activeRuns().delete(runId);
}

export function cancelActiveRun(runId: string, reason = "用户取消了 Agent Run"): boolean {
  const active = activeRuns().get(runId);
  if (!active) return false;
  active.controller.abort(reason);
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns().has(runId);
}
