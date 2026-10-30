import { JobsOptions } from 'bullmq';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto';
import { JobName, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum';
import { JobCounts, JobItem } from 'src/types';

type Timer = ReturnType<typeof setTimeout>;

type MemoryJob = {
  id: string;
  item: JobItem;
  timestamp: number;
  deduplicationKey?: string;
  timer?: Timer;
};

type MemoryQueueState = {
  active: Map<string, MemoryJob>;
  concurrency: number;
  delayed: MemoryJob[];
  failed: MemoryJob[];
  paused: boolean;
  sequence: number;
  started: boolean;
  waiting: MemoryJob[];
};

export type MemoryJobProcessor = (queueName: QueueName, item: JobItem) => Promise<void>;

export class MemoryJobQueue {
  readonly #queues = new Map<QueueName, MemoryQueueState>();

  constructor(private readonly processor: MemoryJobProcessor) {
    for (const queueName of Object.values(QueueName)) {
      this.#queues.set(queueName, {
        active: new Map(),
        concurrency: 1,
        delayed: [],
        failed: [],
        paused: false,
        sequence: 0,
        started: false,
        waiting: [],
      });
    }
  }

  start() {
    for (const [queueName, queue] of this.#queues) {
      queue.started = true;
      this.#drain(queueName);
    }
  }

  teardown() {
    for (const queue of this.#queues.values()) {
      for (const job of queue.delayed) {
        if (job.timer) {
          clearTimeout(job.timer);
        }
      }
      queue.delayed = [];
      queue.waiting = [];
      queue.started = false;
    }
  }

  setConcurrency(queueName: QueueName, concurrency: number) {
    const queue = this.#get(queueName);
    queue.concurrency = Math.max(1, concurrency);
    this.#drain(queueName);
  }

  add(queueName: QueueName, item: JobItem, options?: JobsOptions) {
    const queue = this.#get(queueName);
    const deduplicationKey = options?.jobId?.toString() ?? options?.deduplication?.id;
    if (deduplicationKey && this.#hasDeduplicationKey(queue, deduplicationKey)) {
      return;
    }

    const job: MemoryJob = {
      id: options?.jobId?.toString() ?? `${queueName}-${++queue.sequence}`,
      item: { ...item, data: item.data ?? {} } as JobItem,
      timestamp: Date.now(),
      deduplicationKey,
    };

    if (options?.delay && options.delay > 0) {
      queue.delayed.push(job);
      job.timer = setTimeout(() => {
        queue.delayed = queue.delayed.filter(({ id }) => id !== job.id);
        job.timer = undefined;
        this.#enqueue(queue, job, options);
        this.#drain(queueName);
      }, options.delay);
      return;
    }

    this.#enqueue(queue, job, options);
    this.#drain(queueName);
  }

  isActive(queueName: QueueName) {
    return this.#get(queueName).active.size > 0;
  }

  isPaused(queueName: QueueName) {
    return this.#get(queueName).paused;
  }

  pause(queueName: QueueName) {
    this.#get(queueName).paused = true;
  }

  resume(queueName: QueueName) {
    const queue = this.#get(queueName);
    queue.paused = false;
    this.#drain(queueName);
  }

  empty(queueName: QueueName) {
    const queue = this.#get(queueName);
    for (const job of queue.delayed) {
      if (job.timer) {
        clearTimeout(job.timer);
      }
    }
    queue.delayed = [];
    queue.waiting = [];
  }

  clear(queueName: QueueName, type: QueueCleanType): MemoryJob[] {
    if (type !== QueueCleanType.Failed) {
      return [];
    }
    const queue = this.#get(queueName);
    return queue.failed.splice(0, 1000);
  }

  getJobCounts(queueName: QueueName): JobCounts {
    const queue = this.#get(queueName);
    return {
      active: queue.active.size,
      completed: 0,
      failed: queue.failed.length,
      delayed: queue.delayed.length,
      waiting: queue.paused ? 0 : queue.waiting.length,
      paused: queue.paused ? queue.waiting.length : 0,
    };
  }

  searchJobs(queueName: QueueName, dto: QueueJobSearchDto): QueueJobResponseDto[] {
    const queue = this.#get(queueName);
    const statuses = new Set(dto.status ?? Object.values(QueueJobStatus));
    const jobs = [
      ...(statuses.has(QueueJobStatus.Active) ? [...queue.active.values()] : []),
      ...(statuses.has(QueueJobStatus.Failed) ? queue.failed : []),
      ...(statuses.has(QueueJobStatus.Delayed) ? queue.delayed : []),
      ...(statuses.has(queue.paused ? QueueJobStatus.Paused : QueueJobStatus.Waiting) ? queue.waiting : []),
    ];

    return jobs.slice(0, 1000).map(({ id, item, timestamp }) => ({
      id,
      name: item.name as JobName,
      timestamp,
      data: (item.data ?? {}) as Record<string, unknown>,
    }));
  }

  remove(queueName: QueueName, jobId: string) {
    const queue = this.#get(queueName);
    const delayed = queue.delayed.find(({ id }) => id === jobId);
    if (delayed?.timer) {
      clearTimeout(delayed.timer);
    }
    queue.delayed = queue.delayed.filter(({ id }) => id !== jobId);
    queue.waiting = queue.waiting.filter(({ id }) => id !== jobId);
    queue.failed = queue.failed.filter(({ id }) => id !== jobId);
  }

  #enqueue(queue: MemoryQueueState, job: MemoryJob, options?: JobsOptions) {
    if (options?.priority === undefined) {
      queue.waiting.push(job);
    } else {
      queue.waiting.unshift(job);
    }
  }

  #drain(queueName: QueueName) {
    const queue = this.#get(queueName);
    while (queue.started && !queue.paused && queue.active.size < queue.concurrency && queue.waiting.length > 0) {
      const job = queue.waiting.shift()!;
      queue.active.set(job.id, job);
      void this.#process(queueName, queue, job);
    }
  }

  async #process(queueName: QueueName, queue: MemoryQueueState, job: MemoryJob) {
    try {
      await this.processor(queueName, job.item);
    } catch {
      queue.failed.push(job);
    } finally {
      queue.active.delete(job.id);
      this.#drain(queueName);
    }
  }

  #get(queueName: QueueName) {
    return this.#queues.get(queueName)!;
  }

  #hasDeduplicationKey(queue: MemoryQueueState, key: string) {
    return [...queue.active.values(), ...queue.waiting, ...queue.delayed, ...queue.failed].some(
      ({ deduplicationKey }) => deduplicationKey === key,
    );
  }
}
