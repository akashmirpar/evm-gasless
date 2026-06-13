import { MigrationInterface, QueryRunner } from 'typeorm';

export class RetryPolicyColumns1781280000000 implements MigrationInterface {
  name = 'RetryPolicyColumns1781280000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['transaction_request', 'solana_transaction_request']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "max_retry_times" smallint,
          ADD COLUMN "base_delay_ms" integer,
          ADD COLUMN "exponential_rate" real
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['transaction_request', 'solana_transaction_request']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN "exponential_rate",
          DROP COLUMN "base_delay_ms",
          DROP COLUMN "max_retry_times"
      `);
    }
  }
}
