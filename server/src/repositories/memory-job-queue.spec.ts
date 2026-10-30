import { JobName, QueueCleanType, QueueJobStatus, QueueName } from 'src/enum';
import { MemoryJobQueue } from 'src/repositories/memory-job-queue';
import { JobItem } from 'src/types';

const job = (name = JobName.VersionCheck): JobItem => ({ name }) as JobItem;

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe(MemoryJobQueue.name, () => {
  it('processes jobs only after workers start', async () => {
    const processor = vi.fn(async () => {});
    const queue = new MemoryJobQueue(processor);
    queue.add(QueueName.BackgroundTask, job());

    expect(processor).not.toHaveBeenCalled();
    expect(queue.getJobCounts(QueueName.BackgroundTask).waiting).toBe(1);

    queue.start();
    await tick();
    expect(processor).toHaveBeenCalledOnce();
    expect(queue.getJobCounts(QueueName.BackgroundTask).active).toBe(0);
  });

  it('honors concurrency and drains queued jobs', async () => {
    const releases: Array<() => void> = [];
    const processor = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const queue = new MemoryJobQueue(processor);
    queue.setConcurrency(QueueName.BackgroundTask, 2);
    queue.start();

    queue.add(QueueName.BackgroundTask, job());
    queue.add(QueueName.BackgroundTask, job(JobName.DatabaseBackup));
    queue.add(QueueName.BackgroundTask, job(JobName.UserDeleteCheck));
    expect(processor).toHaveBeenCalledTimes(2);
    expect(queue.getJobCounts(QueueName.BackgroundTask)).toMatchObject({ active: 2, waiting: 1 });

    releases.shift()!();
    await tick();
    expect(processor).toHaveBeenCalledTimes(3);
    for (const release of releases.splice(0)) {
      release();
    }
    await tick();
  });

  it('supports pause, resume, delayed jobs and empty', async () => {
    vi.useFakeTimers();
    const processor = vi.fn(async () => {});
    const queue = new MemoryJobQueue(processor);
    queue.start();
    queue.pause(QueueName.Notification);
    queue.add(QueueName.Notification, job(), { delay: 1000 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(processor).not.toHaveBeenCalled();
    expect(queue.getJobCounts(QueueName.Notification)).toMatchObject({ paused: 1, delayed: 0 });

    queue.resume(QueueName.Notification);
    await vi.runAllTimersAsync();
    expect(processor).toHaveBeenCalledOnce();

    queue.pause(QueueName.Notification);
    queue.add(QueueName.Notification, job(JobName.NotifyUserSignup));
    queue.empty(QueueName.Notification);
    expect(queue.getJobCounts(QueueName.Notification).paused).toBe(0);
    vi.useRealTimers();
  });

  it('deduplicates pending jobs and allows removal by job id', () => {
    const queue = new MemoryJobQueue(vi.fn(async () => {}));
    queue.add(QueueName.BackgroundTask, job(), { jobId: 'unique' });
    queue.add(QueueName.BackgroundTask, job(), { jobId: 'unique' });
    expect(queue.getJobCounts(QueueName.BackgroundTask).waiting).toBe(1);

    queue.remove(QueueName.BackgroundTask, 'unique');
    expect(queue.getJobCounts(QueueName.BackgroundTask).waiting).toBe(0);
  });

  it('retains failed jobs for search and clear', async () => {
    const queue = new MemoryJobQueue(vi.fn().mockRejectedValue(new Error('failed')));
    queue.start();
    queue.add(QueueName.BackgroundTask, job());
    await tick();

    expect(queue.getJobCounts(QueueName.BackgroundTask).failed).toBe(1);
    expect(queue.searchJobs(QueueName.BackgroundTask, { status: [QueueJobStatus.Failed] } as never)).toHaveLength(1);
    expect(queue.clear(QueueName.BackgroundTask, QueueCleanType.Failed)).toHaveLength(1);
    expect(queue.getJobCounts(QueueName.BackgroundTask).failed).toBe(0);
  });
});
