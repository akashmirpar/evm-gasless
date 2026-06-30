import { StateMachine } from './state_machine';

enum S { A = 0, B = 10, C = 20 }
enum Act { Go = 1, Back = 2 }

describe('StateMachine', () => {
  it('next returns the destination for a defined transition', () => {
    const fsm = new StateMachine<S, Act>([
      { from: S.A, action: Act.Go, to: S.B },
      { from: S.B, action: Act.Go, to: S.C },
    ]);
    expect(fsm.next(S.A, Act.Go)).toBe(S.B);
    expect(fsm.next(S.B, Act.Go)).toBe(S.C);
  });

  it('next returns undefined for an undefined transition', () => {
    const fsm = new StateMachine<S, Act>([{ from: S.A, action: Act.Go, to: S.B }]);
    expect(fsm.next(S.A, Act.Back)).toBeUndefined();
    expect(fsm.next(S.C, Act.Go)).toBeUndefined();
  });

  it('can returns true iff next is defined', () => {
    const fsm = new StateMachine<S, Act>([{ from: S.A, action: Act.Go, to: S.B }]);
    expect(fsm.can(S.A, Act.Go)).toBe(true);
    expect(fsm.can(S.A, Act.Back)).toBe(false);
  });

  it('throws on duplicate (from, action) at construction', () => {
    expect(() => new StateMachine<S, Act>([
      { from: S.A, action: Act.Go, to: S.B },
      { from: S.A, action: Act.Go, to: S.C },
    ])).toThrow(/duplicate/i);
  });
});
