import { Injectable } from '@nestjs/common';

@Injectable()
export abstract class BaseJob {
  abstract execute(): Promise<void>;

  get name(): string {
    return this.constructor.name;
  }
}
