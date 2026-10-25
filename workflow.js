// Same "reached" window as the official app: within 1 °C below the target.
const REACHED_MARGIN = 1;
const POLL_MS = 500;

// Seed list for a fresh browser, times in seconds.
export const DEFAULT_WORKFLOWS = [
  { name: 'Day', steps: [{ temp: 178, hold: 5, air: 40 }] },
  { name: 'Night', steps: [{ temp: 186, hold: 5, air: 40 }] },
];

// Per step: set target, wait until reached, hold, pump air. Heat and air are
// switched off when the workflow ends, fails, or `signal` aborts it.
export async function runWorkflow(volcano, workflow, { signal, onProgress = () => {} } = {}) {
  try {
    for (const [index, step] of workflow.steps.entries()) {
      signal?.throwIfAborted();
      onProgress({ index, step, phase: 'heating' });
      await volcano.setTarget(step.temp);
      if (index === 0) await volcano.heat(true);
      while (!(volcano.temp >= step.temp - REACHED_MARGIN)) await sleep(POLL_MS, signal);

      onProgress({ index, step, phase: 'holding' });
      await sleep(step.hold * 1000, signal);

      if (step.air > 0) {
        onProgress({ index, step, phase: 'air' });
        await volcano.air(true);
        await sleep(step.air * 1000, signal);
        await volcano.air(false);
      }
    }
  } finally {
    await volcano.air(false).catch(() => {});
    await volcano.heat(false).catch(() => {});
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
