import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BaseJob } from './base.job';
import { SchedulerName, timeOverrideEnvKey } from './scheduler_name';

interface JobRegistration {
  job: BaseJob;
  cronTime: string;
}

@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly jobs = new Map<SchedulerName, JobRegistration>();

  constructor(private readonly registry: SchedulerRegistry) {}

  register(name: SchedulerName, job: BaseJob, defaultCronTime: string): void {
    const override = process.env[timeOverrideEnvKey(name)];
    const cronTime = override && override.trim().length > 0 ? override.trim() : defaultCronTime;
    this.jobs.set(name, { job, cronTime });
  }

  onApplicationBootstrap(): void {
    for (const [name, { job, cronTime }] of this.jobs) {
      const cronJob = new CronJob(cronTime, () => {
        this.run(name, job).catch((err) => {
          this.logger.error(`unhandled scheduled job failure name=${name} err=${(err as Error)?.message ?? err}`);
        });
      });
      this.registry.addCronJob(name, cronJob as never);
      cronJob.start();
      this.logger.log(`registered ${name} (${cronTime}) -> ${job.name}`);
    }
  }

  private async run(name: SchedulerName, job: BaseJob): Promise<void> {
    const start = Date.now();
    try {
      await job.execute();
    } catch (err) {
      this.logger.error(`scheduled job threw name=${name} err=${(err as Error)?.message ?? err}`);
    } finally {
      this.logger.debug(`tick complete name=${name} durationMs=${Date.now() - start}`);
    }
  }
}
