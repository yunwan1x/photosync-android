export type Task = () => Promise<unknown> | unknown;

export class Tasks {
  private tasks: Task[] = [];

  push(...tasks: Task[]) {
    this.tasks.push(...tasks);
  }

  async all({ concurrent = true }: { concurrent?: boolean } = {}) {
    if (concurrent) {
      await Promise.all(this.tasks.map((item) => item()));
      return;
    }

    for (const task of this.tasks) {
      await task();
    }
  }
}
