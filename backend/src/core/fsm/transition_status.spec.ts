import { transitionStatus } from './transition_status';
import { StateMachine } from './state_machine';
import { PlutonException, isPlutonException } from '../../common/errors';
import { SystemErrors } from '../../common/errors/system.errors';

enum S { A = 0, B = 10 }
enum Act { Go = 1 }

class FakeEntity { id!: string; status!: S; }

function fakeCtx(updateAffected: number, loaded: { status: S } | null) {
  const insertMock = jest.fn().mockResolvedValue(undefined);
  const updateMock = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: updateAffected }),
  };
  const manager = {
    findOneByOrFail: jest.fn().mockImplementation(() => loaded ? Promise.resolve(loaded) : Promise.reject(new Error('not found'))),
    createQueryBuilder: jest.fn().mockReturnValue(updateMock),
    insert: insertMock,
  };
  return { tx: { manager } as unknown as { manager: typeof manager }, actor: { id: 'system' }, insertMock, updateMock };
}

describe('transitionStatus', () => {
  const fsm = new StateMachine<S, Act>([{ from: S.A, action: Act.Go, to: S.B }]);

  it('returns from/to and inserts a log row when CAS succeeds', async () => {
    const ctx = fakeCtx(1, { status: S.A });
    const result = await transitionStatus(ctx as never, FakeEntity as never, 'id-1', Act.Go, fsm);
    expect(result).toEqual({ from: S.A, to: S.B });
    expect(ctx.insertMock).toHaveBeenCalledTimes(1);
    expect(ctx.updateMock.where).toHaveBeenCalledWith('id = :id AND status = :from', expect.objectContaining({ id: 'id-1', from: S.A }));
  });

  it('throws ConcurrentTransition and DOES NOT log when CAS affects 0 rows', async () => {
    const ctx = fakeCtx(0, { status: S.A });
    await expect(transitionStatus(ctx as never, FakeEntity as never, 'id-1', Act.Go, fsm))
      .rejects
      .toMatchObject(expect.objectContaining({ errorInfo: expect.objectContaining({ code: SystemErrors.ConcurrentTransition.code }) }));
    expect(ctx.insertMock).not.toHaveBeenCalled();
  });

  it('throws IllegalTransition when fsm has no entry for (from, action)', async () => {
    const ctx = fakeCtx(1, { status: S.B });
    await expect(transitionStatus(ctx as never, FakeEntity as never, 'id-1', Act.Go, fsm))
      .rejects
      .toMatchObject(expect.objectContaining({ errorInfo: expect.objectContaining({ code: SystemErrors.IllegalTransition.code }) }));
  });

  it('throws NotFound when row is missing', async () => {
    const ctx = fakeCtx(1, null);
    await expect(transitionStatus(ctx as never, FakeEntity as never, 'id-1', Act.Go, fsm))
      .rejects
      .toBeDefined();
  });
});
