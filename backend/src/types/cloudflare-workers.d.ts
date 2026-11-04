/**
 * The parts of `cloudflare:workers` that worker.ts uses: the Workflow base class and what its
 * `run` method is handed.
 *
 * Like cloudflare-node.d.ts, this exists because the module is provided by the Workers runtime and
 * has no package. It describes only what is called, following Cloudflare's Workflows API reference;
 * the full generated types (`wrangler types`) replace it once the Worker has its own configuration.
 */
declare module 'cloudflare:workers' {
  export interface WorkflowEvent<Params> {
    /** The `params` the instance was created with. */
    readonly payload: Readonly<Params>;
    readonly timestamp: Date;
    readonly instanceId: string;
  }

  export interface WorkflowStepConfig {
    retries?: {
      limit: number;
      delay: string | number;
      backoff?: 'constant' | 'linear' | 'exponential';
    };
    timeout?: string | number;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: string | number): Promise<void>;
  }

  /** The storage calls cloudflare/rate-limiter.ts makes. */
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAll(): Promise<void>;
  }

  export interface DurableObjectState {
    readonly storage: DurableObjectStorage;
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
