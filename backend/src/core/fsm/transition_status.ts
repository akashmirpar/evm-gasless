import { EntityManager } from 'typeorm';

import { BaseStatefulEntity } from '../../common/base-stateful.entity';
import { PlutonException, SystemErrors } from '../../common/errors';
import { TransitionLogEntity } from '../../common/transition_log.entity';
import { IContext } from '../context/context';
import { StateMachine } from './state_machine';

export interface TransitionResult<S> {
  from: S;
  to: S;
}

export async function transitionStatus<S extends number, A extends number, E extends BaseStatefulEntity<S>>(
  ctx: IContext,
  entityClass: { new (): E; name: string },
  entityId: string,
  action: A,
  fsm: StateMachine<S, A>,
  metadata?: Record<string, unknown>,
): Promise<TransitionResult<S>> {
  const manager: EntityManager = ctx.tx.manager;
  const current = await manager.findOneByOrFail(entityClass, { id: entityId } as never).catch((err) => {
    throw PlutonException(SystemErrors.NotFound, err);
  });
  const from = current.status;
  const to = fsm.next(from, action);
  if (to === undefined) {
    throw PlutonException(SystemErrors.IllegalTransition, { from, action });
  }

  const result = await manager
    .createQueryBuilder()
    .update(entityClass)
    .set({ status: to } as never)
    .where('id = :id AND status = :from', { id: entityId, from })
    .execute();
  if (result.affected === 0) {
    throw PlutonException(SystemErrors.ConcurrentTransition, { entityId, expectedFrom: from });
  }

  await manager.insert(TransitionLogEntity, {
    entity: entityClass.name,
    entityId,
    fromStatus: from as number,
    toStatus: to as number,
    action: action as number,
    transitionBy: ctx.actor.id,
    metadata: (metadata ?? null) as never,
  });

  return { from, to };
}
