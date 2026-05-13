export interface ITransition<S extends number, A extends number> {
  from: S;
  action: A;
  to: S;
}

export class StateMachine<S extends number, A extends number> {
  private readonly table = new Map<string, S>();

  constructor(public readonly transitions: ReadonlyArray<ITransition<S, A>>) {
    for (const t of transitions) {
      const key = StateMachine.key(t.from, t.action);
      if (this.table.has(key)) {
        throw new Error(`FSM duplicate transition: from=${t.from} action=${t.action}`);
      }
      this.table.set(key, t.to);
    }
  }

  next(from: S, action: A): S | undefined {
    return this.table.get(StateMachine.key(from, action));
  }

  can(from: S, action: A): boolean {
    return this.table.has(StateMachine.key(from, action));
  }

  private static key(from: number, action: number): string {
    return `${from}:${action}`;
  }
}
