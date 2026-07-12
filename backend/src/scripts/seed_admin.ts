import 'reflect-metadata';

import { randomBytes } from 'crypto';

import { AppDataSource } from '../core/database/data-source';
import { AdminEntity } from '../modules/admin/domain/entity/admin.entity';
import { AdminAuditEntity, AdminAuditOutcome } from '../modules/admin/domain/entity/admin_audit.entity';

const NAME_FLAG = '--name';
const KEY_PREFIX = 'ga_live_';

/**
 * One-shot bootstrap for the very first admin. Refuses to run if any active
 * admin with a key already exists — the operator should rotate an existing
 * key or create a new admin via the API instead of double-inserting.
 *
 *   npm run seed:admin -- --name root
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf(NAME_FLAG);
  const name = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : 'root';

  await AppDataSource.initialize();

  try {
    const adminRepo = AppDataSource.getRepository(AdminEntity);
    const auditRepo = AppDataSource.getRepository(AdminAuditEntity);

    const existing = await adminRepo.count({ where: { isActive: true } });
    if (existing > 0) {
      throw new Error(
        `seed:admin refuses to run — the admin table already has ${existing} active row(s). ` +
          'Use POST /admin/admins with an existing key instead.',
      );
    }

    const clash = await adminRepo.findOne({ where: { name } });
    if (clash) {
      throw new Error(`admin name "${name}" already exists (id=${clash.id}) — pick another with --name`);
    }

    const plaintextKey = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

    const admin = await AppDataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(AdminEntity).save({
        name,
        key: plaintextKey,
        isActive: true,
      });
      await manager.getRepository(AdminAuditEntity).save({
        adminId: saved.id,
        actorAdminId: saved.id,
        outcome: AdminAuditOutcome.Created,
        ip: null,
        userAgent: 'seed:admin CLI',
        reason: 'bootstrap',
      });
      return saved;
    });

    process.stdout.write(
      [
        '',
        '=== gasless bootstrap admin created ===',
        `id:   ${admin.id}`,
        `name: ${admin.name}`,
        `key:  ${plaintextKey}`,
        '',
        'Store this key somewhere safe. It will never be shown again.',
        'Use it via the "x-admin-key" header against /admin/* endpoints.',
        '',
      ].join('\n'),
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  process.stderr.write(`seed:admin failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
