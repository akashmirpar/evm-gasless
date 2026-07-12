import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const MODULES_DIR = join(__dirname, '..', '..', 'modules');

/**
 * Guard against a controller being added without an auth guard. Every
 * `*.controller.ts` under `src/modules/**` must either be pinned to
 * `ApiKeyGuard` (integrator surface) or `AdminKeyGuard` (admin surface),
 * with the sole exception of `HealthController` (unauthenticated liveness
 * probe under `src/core/`).
 */
describe('boot-time route audit', () => {
  const controllers = findControllers(MODULES_DIR);

  it('discovers the known controllers (regression against a rename that hides one)', () => {
    const names = controllers.map((p) => p.split('/').pop());
    expect(names).toEqual(
      expect.arrayContaining(['evm.controller.ts', 'solana.controller.ts', 'admin.controller.ts', 'api_key.controller.ts']),
    );
  });

  it.each(
    controllers.map((path) => [path.replace(MODULES_DIR + '/', ''), path]),
  )('%s carries a @UseGuards(...) with ApiKeyGuard or AdminKeyGuard', (_relative, path) => {
    const src = readFileSync(path, 'utf8');

    // Every file we scan is expected to define at least one @Controller.
    expect(src).toMatch(/@Controller\s*\(/);

    const hasIntegratorGuard = /@UseGuards\([^)]*\bApiKeyGuard\b[^)]*\)/.test(src);
    const hasAdminGuard = /@UseGuards\([^)]*\bAdminKeyGuard\b[^)]*\)/.test(src);
    expect(hasIntegratorGuard || hasAdminGuard).toBe(true);
  });
});

function findControllers(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith('.controller.ts')) {
        out.push(full);
      }
    }
  }
  return out.sort();
}
