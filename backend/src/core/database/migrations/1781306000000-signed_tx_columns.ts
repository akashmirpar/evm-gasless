import { MigrationInterface, QueryRunner } from 'typeorm';

export class SignedTxColumns1781306000000 implements MigrationInterface {
  name = 'SignedTxColumns1781306000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['transaction_request']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN "signed_tx" text
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['transaction_request']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN "signed_tx"
      `);
    }
  }
}
