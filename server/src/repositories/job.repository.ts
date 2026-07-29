import { Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { JobConfig } from 'src/decorators';
import { QueueJobResponseDto, QueueJobSearchDto } from 'src/dtos/queue.dto';
import { JobName, JobStatus, MetadataKey, QueueCleanType, QueueName } from 'src/enum';
import { ConfigRepository } from 'src/repositories/config.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { JobCounts, JobItem, JobOf } from 'src/types';
import { getMethodNames } from 'src/utils/misc';

type JobMapItem = {
  jobName: JobName;
  queueName: QueueName;
  handler: (job: JobOf<any>) => Promise<JobStatus>;
  label: string;
};

/**
 * In-process job queue (no Redis / BullMQ).
 *
 * The original implementation backed every queue with BullMQ + Redis so the API
 * and microservices workers could share a job store. In the single-container
 * lightweight build there is only one process, so jobs are dispatched directly
 * in-memory via setImmediate. Public method signatures are preserved so the
 * rest of the codebase (BaseService, JobController, etc.) compiles unchanged.
 *
 * Trade-off: jobs are not persisted across restarts and concurrency control is
 * best-effort. Acceptable for a personal, single-container deployment.
 */
@Injectable()
export class JobRepository {
  private handlers: Partial<Record<JobName, JobMapItem>> = {};
  private paused = new Set<QueueName>();
  private inflight = 0;

  constructor(
    private moduleRef: ModuleRef,
    private configRepository: ConfigRepository,
    private eventRepository: EventRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(JobRepository.name);
  }

  setup(services: (new (...args: any[]) => unknown)[]) {
    const reflector = this.moduleRef.get(Reflector, { strict: false });

    // discovery
    for (const Service of services) {
      const instance = this.moduleRef.get<any>(Service);
      for (const methodName of getMethodNames(instance)) {
        const handler = instance[methodName];
        const config = reflector.get<JobConfig>(MetadataKey.JobConfig, handler);
        if (!config) {
          continue;
        }

        const { name: jobName, queue: queueName } = config;
        const label = `${Service.name}.${handler.name}`;

        this.handlers[jobName] = {
          label,
          jobName,
          queueName,
          handler: handler.bind(instance),
        };

        this.logger.verbose(`Added job handler: ${jobName} => ${label}`);
      }
    }

    // Missing handlers are expected in the lightweight build: face-detection,
    // CLIP, transcoding, OCR and duplicate-detection services have been removed,
    // so their jobs simply won't run. Warn instead of throwing.
    for (const [jobKey, jobName] of Object.entries(JobName)) {
      if (!this.handlers[jobName]) {
        this.logger.warn(`No job handler for Job.${jobKey} ("${jobName}") — it will be skipped.`);
      }
    }
  }

  startWorkers() {
    this.logger.log('In-process job queue ready (no separate workers).');
  }

  watchWorkers() {
    // no-op: single process, nothing to watch
  }

  teardown() {
    // no-op
  }

  async run({ name, data }: JobItem) {
    const item = this.handlers[name as JobName];
    if (!item) {
      this.logger.verbose(`Skipping unknown/unhandled job: "${name}"`);
      return JobStatus.Skipped;
    }

    this.inflight++;
    try {
      return await item.handler(data);
    } finally {
      this.inflight = Math.max(0, this.inflight - 1);
    }
  }

  setConcurrency(_queueName: QueueName, _concurrency: number) {
    // no-op for in-process queue
  }

  async isActive(_name: QueueName): Promise<boolean> {
    return this.inflight > 0;
  }

  async isPaused(name: QueueName): Promise<boolean> {
    return this.paused.has(name);
  }

  async pause(name: QueueName) {
    this.paused.add(name);
  }

  async resume(name: QueueName) {
    this.paused.delete(name);
  }

  async empty(_name: QueueName) {
    // nothing persisted to drain
  }

  async clear(_name: QueueName, _type: QueueCleanType) {
    // nothing persisted to clean
  }

  async getJobCounts(_name: QueueName): Promise<JobCounts> {
    return { active: this.inflight, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0 };
  }

  async queueAll(items: JobItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }

    for (const item of items) {
      const queueName = this.handlers[item.name as JobName]?.queueName;
      if (!queueName) {
        this.logger.verbose(`Skipping unhandled job on queue: "${item.name}"`);
        continue;
      }

      if (this.paused.has(queueName)) {
        this.logger.verbose(`Queue "${queueName}" is paused, skipping job "${item.name}"`);
        continue;
      }

      // Dispatch in-process, non-blocking. Errors are logged but never crash the queue.
      setImmediate(() => {
        this.run(item).catch((error) => this.logger.error(`Job "${item.name}" failed: ${error}`));
      });
    }
  }

  async queue(item: JobItem): Promise<void> {
    return this.queueAll([item]);
  }

  async waitForQueueCompletion(..._queues: QueueName[]): Promise<void> {
    while (this.inflight > 0) {
      this.logger.verbose(`Waiting for ${this.inflight} in-flight job(s) to finish...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async searchJobs(_name: QueueName, _dto: QueueJobSearchDto): Promise<QueueJobResponseDto[]> {
    return [];
  }

  /** @deprecated */
  public async removeJob(_name: JobName, _jobID: string): Promise<void> {
    // no-op
  }
}
