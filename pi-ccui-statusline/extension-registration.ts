type RegistrationStep = () => unknown;

type RegistrationRecord = {
  steps: RegistrationStep[];
  nextStep: number;
  complete: boolean;
};

type RegistrationRegistry = WeakMap<object, RegistrationRecord>;

const REGISTRY_KEY = Symbol.for("pi-ccui-statusline.registration-registry.v2");

export type RegistrationLease = {
  guard<T extends (...args: never[]) => unknown>(handler: T): T;
};

/** Register physical Pi handlers once per API and resume interrupted registration. */
export function installStatusline(
  api: object,
  buildSteps: (lease: RegistrationLease) => RegistrationStep[],
): void {
  const registry = getRegistry();
  const existing = registry.get(api);
  if (existing) {
    resumeRegistration(existing);
    return;
  }

  const record: RegistrationRecord = { steps: [], nextStep: 0, complete: false };
  registry.set(api, record);
  const lease = createLease(registry, api, record);
  try {
    record.steps = buildSteps(lease);
  } catch (error) {
    registry.delete(api);
    throw error;
  }
  resumeRegistration(record);
}

/** Return the process-wide weak registry shared by cache-busted module copies. */
function getRegistry(): RegistrationRegistry {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY];
  if (existing instanceof WeakMap) return existing as RegistrationRegistry;

  const registry: RegistrationRegistry = new WeakMap();
  host[REGISTRY_KEY] = registry;
  return registry;
}

/** Keep partially registered handlers inert until every physical step succeeds. */
function createLease(
  registry: RegistrationRegistry,
  api: object,
  record: RegistrationRecord,
): RegistrationLease {
  return {
    guard: <T extends (...args: never[]) => unknown>(handler: T): T => {
      const guarded = (...args: unknown[]) => {
        const current = registry.get(api);
        if (current !== record || !current.complete) return undefined;
        return (handler as unknown as (...values: unknown[]) => unknown)(...args);
      };
      return guarded as unknown as T;
    },
  };
}

/** Continue at the first unfinished synchronous registration step. */
function resumeRegistration(record: RegistrationRecord): void {
  if (record.complete) return;
  while (record.nextStep < record.steps.length) {
    const result = record.steps[record.nextStep]();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      Promise.resolve(result).catch(() => undefined);
      throw new Error("statusline registration steps must be synchronous");
    }
    record.nextStep += 1;
  }
  record.complete = true;
  record.steps = [];
}
