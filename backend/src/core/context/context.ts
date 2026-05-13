import { Logger } from '@nestjs/common';
import { EntityManager, QueryRunner } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { AppDataSource } from '../database/data-source';

export interface ITransaction {
  get manager(): EntityManager;
  commit(release?: boolean): Promise<void>;
  rollback(release?: boolean): Promise<void>;
  done(): Promise<void>;
  hasOpenTransaction(): boolean;
}

export interface IActor {
  type: 'system' | 'user';
  id: string;
}

export interface IContext {
  traceId: string;
  logger: Logger;
  tx: ITransaction;
  actor: IActor;
  data: Map<string, unknown>;
  bufferedEvents: unknown[];
  bufferEvent(event: unknown): void;
}

export interface ISystemContext extends IContext {
  clone(label: string, params: Record<string, unknown>, startTransaction: boolean): Promise<ISystemContext>;
}

class QueryRunnerTransaction implements ITransaction {
  private queryRunner: QueryRunner | null = null;
  private started = false;

  constructor(private readonly readonly_: boolean = false) {}

  async begin(): Promise<void> {
    if (this.queryRunner) return;
    this.queryRunner = AppDataSource.createQueryRunner();
    await this.queryRunner.connect();
    await this.queryRunner.startTransaction();
    this.started = true;
  }

  get manager(): EntityManager {
    if (!this.queryRunner) {
      return AppDataSource.manager;
    }
    return this.queryRunner.manager;
  }

  async commit(release = true): Promise<void> {
    if (!this.queryRunner || !this.started) return;
    await this.queryRunner.commitTransaction();
    this.started = false;
    if (release) await this.queryRunner.release();
  }

  async rollback(release = true): Promise<void> {
    if (!this.queryRunner || !this.started) return;
    await this.queryRunner.rollbackTransaction();
    this.started = false;
    if (release) await this.queryRunner.release();
  }

  async done(): Promise<void> {
    if (this.queryRunner && !this.queryRunner.isReleased) {
      if (this.started) {
        await this.queryRunner.rollbackTransaction();
        this.started = false;
      }
      await this.queryRunner.release();
    }
  }

  hasOpenTransaction(): boolean {
    return this.started;
  }
}

export class RequestContext implements IContext {
  readonly traceId: string;
  readonly logger: Logger;
  readonly tx: ITransaction;
  readonly actor: IActor;
  readonly data = new Map<string, unknown>();
  readonly bufferedEvents: unknown[] = [];

  constructor(traceId: string | undefined, actor: IActor) {
    this.traceId = traceId ?? uuidv4();
    this.logger = new Logger(`req:${this.traceId.slice(0, 8)}`);
    this.tx = new QueryRunnerTransaction();
    this.actor = actor;
  }

  bufferEvent(event: unknown): void {
    this.bufferedEvents.push(event);
  }
}

export class SystemContext implements ISystemContext {
  readonly traceId: string;
  readonly logger: Logger;
  readonly tx: ITransaction;
  readonly actor: IActor;
  readonly data = new Map<string, unknown>();
  readonly bufferedEvents: unknown[] = [];

  constructor(label: string, traceId?: string) {
    this.traceId = traceId ?? uuidv4();
    this.logger = new Logger(`sys:${label}:${this.traceId.slice(0, 6)}`);
    this.tx = new QueryRunnerTransaction();
    this.actor = { type: 'system', id: label };
  }

  bufferEvent(event: unknown): void {
    this.bufferedEvents.push(event);
  }

  async clone(label: string, _params: Record<string, unknown>, startTransaction: boolean): Promise<ISystemContext> {
    const child = new SystemContext(label, this.traceId);
    if (startTransaction) {
      await (child.tx as QueryRunnerTransaction).begin();
    }
    return child;
  }
}

export async function startSystemTransaction(label: string): Promise<ISystemContext> {
  const ctx = new SystemContext(label);
  await (ctx.tx as QueryRunnerTransaction).begin();
  return ctx;
}
