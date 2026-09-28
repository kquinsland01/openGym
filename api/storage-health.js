// One shared observer for API and Coach writes. A successful unrelated write must never
// clear a failure: only the bounded readiness transaction can do that.
import { Worker } from 'node:worker_threads';
import path from 'node:path';

let observer;
export function storageFailure(error, file) {
  observer?.fail(error, file);
}
export function storageWrite(file, fn) {
  try { return fn(); }
  catch (error) { storageFailure(error, file); throw error; }
}

export function createStorageHealth(data, { intervalMs = 10000, timeoutMs = 1500,
  log = console, workerFactory = () => new Worker(new URL('./storage-health-worker.js', import.meta.url)) } = {}) {
  const root = path.resolve(data);
  const withinData = file => file === root || file.startsWith(root + path.sep);
  const worker = workerFactory();
  let ready = false, inFlight = false, generation = 0, startedGeneration = 0, timeout;
  let overflow = false, closed = false, lastReason;
  const failures = new Map();
  const report = (next, reason) => {
    if (ready !== next || (!next && lastReason !== reason)) log[next ? 'info' : 'error'](`storage readiness ${next ? 'recovered' : 'failed'} (${reason})`);
    ready = next;
    lastReason = reason;
  };
  const health = {
    ready: () => ready,
    fail(error, file) {
      const candidates = [file, error?.path].filter(v => typeof v === 'string');
      if (candidates.length && !candidates.some(v => withinData(path.resolve(v)))) return;
      generation++;
      for (const candidate of new Set(candidates)) {
        const target = path.resolve(candidate);
        if (withinData(target)) {
          const directory = target === root || (candidate === error?.path &&
            (error?.syscall === 'mkdir' || (file && path.resolve(file).startsWith(target + path.sep))));
          if (failures.size < 32 || failures.has(target)) failures.set(target, { file: target, directory });
          else overflow = true; // Never forget failures just to fit a bound; operator restart required.
        }
      }
      report(false, error?.code || 'write');
    },
    check() {
      if (closed || inFlight || overflow) return;
      inFlight = true;
      startedGeneration = generation;
      worker.postMessage({ data, failedFiles: [...failures.values()] });
      timeout = setTimeout(() => report(false, 'timeout'), timeoutMs);
      timeout.unref?.();
    },
    close() {
      closed = true;
      clearTimeout(timeout);
      clearInterval(timer);
      if (observer === health) observer = undefined;
      return worker.terminate();
    },
  };
  worker.on('message', ({ ok, code }) => {
    clearTimeout(timeout);
    inFlight = false;
    if (closed || startedGeneration !== generation) return;
    if (ok) failures.clear();
    report(ok, code || 'check');
  });
  worker.on('error', error => { health.fail(error); closed = true; clearTimeout(timeout); clearInterval(timer); });
  worker.on('exit', () => { if (!closed) { health.fail({ code: 'worker-exit' }); closed = true; clearTimeout(timeout); clearInterval(timer); } });
  const timer = setInterval(() => health.check(), intervalMs);
  timer.unref();
  worker.unref?.();
  observer = health;
  health.check();
  return health;
}
