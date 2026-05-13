import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1715600000000 implements MigrationInterface {
  name = 'Init1715600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "transition_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "entity" character varying NOT NULL,
        "entity_id" uuid NOT NULL,
        "from_status" smallint NOT NULL,
        "to_status" smallint NOT NULL,
        "action" smallint NOT NULL,
        "transition_by" character varying,
        "metadata" jsonb,
        CONSTRAINT "PK_transition_log_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_transition_log_entity" ON "transition_log" ("entity", "entity_id", "created_at")`);

    await queryRunner.query(`
      CREATE TABLE "transaction_request" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "status" smallint NOT NULL,
        "retry_times" smallint NOT NULL DEFAULT 0,
        "next_retry_time" TIMESTAMP WITH TIME ZONE,
        "request_id" character varying NOT NULL,
        "chain_id" bigint NOT NULL,
        "user_address" character varying NOT NULL,
        "delegate_contract_address" character varying NOT NULL,
        "fee_token_address" character varying NOT NULL,
        "fee_amount" numeric(78,0) NOT NULL,
        "atomic_group_start" integer NOT NULL,
        "batch_nonce" numeric(78,0) NOT NULL,
        "operations" jsonb NOT NULL,
        "signature" character varying NOT NULL,
        "authorization" jsonb,
        "tx_hash" character varying,
        "broadcast_rpc_url" character varying,
        "failure_reason" text,
        CONSTRAINT "PK_transaction_request_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_transaction_request_request_id" UNIQUE ("request_id"),
        CONSTRAINT "CHK_transaction_request_status" CHECK (status IN (0, 10, 20, 30, 40, 90))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_transaction_request_status_next_retry" ON "transaction_request" ("status", "next_retry_time")`);
    await queryRunner.query(`CREATE INDEX "IDX_transaction_request_chain_user" ON "transaction_request" ("chain_id", "user_address")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "transaction_request"`);
    await queryRunner.query(`DROP TABLE "transition_log"`);
  }
}
