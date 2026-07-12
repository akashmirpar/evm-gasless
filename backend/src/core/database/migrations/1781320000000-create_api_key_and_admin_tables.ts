import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auth mechanism: two separate tables for two separate identity classes
 * (integrators vs admins) and two audit trails. The tables never reference
 * each other beyond `actor_admin_id` on audit rows.
 */
export class CreateApiKeyAndAdminTables1781320000000 implements MigrationInterface {
  name = 'CreateApiKeyAndAdminTables1781320000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key" (
        "id"             uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        "updated_at"     timestamptz,
        "deleted_at"     timestamptz,
        "client_name"    varchar,
        "key"            varchar NOT NULL,
        "rate_limit_rps" int NOT NULL DEFAULT 5,
        "white_list"     varchar,
        "expires_at"     timestamptz,
        "is_active"      boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_api_key_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_api_key_key" UNIQUE ("key")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin" (
        "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz,
        "deleted_at" timestamptz,
        "name"       varchar NOT NULL,
        "key"        varchar,
        "is_active"  boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_admin_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_admin_name" UNIQUE ("name")
      )
    `);

    // Partial unique index on admin.key: allows NULL (future SIWE-only admin) but
    // enforces uniqueness when present.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_admin_key"
        ON "admin" ("key") WHERE "key" IS NOT NULL
    `);

    // Supports the "is there another active admin?" check.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_admin_active"
        ON "admin" ("is_active") WHERE "deleted_at" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_key_audit" (
        "id"              uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "api_key_id"      uuid NOT NULL,
        "actor_admin_id"  uuid NOT NULL,
        "outcome"         varchar NOT NULL,
        "ip"              varchar,
        "user_agent"      text,
        "reason"          text,
        CONSTRAINT "PK_api_key_audit_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_api_key_audit_api_key"
          FOREIGN KEY ("api_key_id")     REFERENCES "api_key" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_api_key_audit_admin"
          FOREIGN KEY ("actor_admin_id") REFERENCES "admin"   ("id") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_audit" (
        "id"              uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at"      timestamptz NOT NULL DEFAULT now(),
        "admin_id"        uuid NOT NULL,
        "actor_admin_id"  uuid NOT NULL,
        "outcome"         varchar NOT NULL,
        "ip"              varchar,
        "user_agent"      text,
        "reason"          text,
        CONSTRAINT "PK_admin_audit_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_admin_audit_admin"
          FOREIGN KEY ("admin_id")       REFERENCES "admin" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_admin_audit_actor"
          FOREIGN KEY ("actor_admin_id") REFERENCES "admin" ("id") ON DELETE RESTRICT
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "admin_audit"');
    await queryRunner.query('DROP TABLE IF EXISTS "api_key_audit"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_admin_active"');
    await queryRunner.query('DROP INDEX IF EXISTS "UQ_admin_key"');
    await queryRunner.query('DROP TABLE IF EXISTS "admin"');
    await queryRunner.query('DROP TABLE IF EXISTS "api_key"');
  }
}
