import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { StartedTestContainer } from 'testcontainers';
import supertest from 'supertest';

import { AdminEntity } from 'src/modules/admin/domain/entity/admin.entity';
import { AppDataSource } from 'src/core/database/data-source';

import { bootBackend } from './helpers';

const BOOTSTRAP_ADMIN_NAME = `bootstrap-${randomBytes(4).toString('hex')}`;

/**
 * End-to-end auth flow, running against a real Postgres + Redis (testcontainers).
 * Covers: guard rejects an unauthenticated call, an admin can mint an integrator
 * key, the key opens the gasless surface, deactivating the key blocks new calls,
 * and the admin routes require an admin key.
 */
describe('auth e2e (real db + redis)', () => {
  let app: INestApplication;
  let http: supertest.Agent;
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let adminKey: string;

  beforeAll(async () => {
    // The gasless controllers boot with a stub RPC config so this suite does
    // not need any private keys — the guard sits in front of everything.
    const booted = await bootBackend({
      GASLESS_ACCEPTED_FEE_TOKENS: '0x0000000000000000000000000000000000000000',
    });
    app = booted.app;
    http = booted.http;
    postgres = booted.postgres;
    redis = booted.redis;

    // Bootstrap admin directly (equivalent to `npm run seed:admin`).
    adminKey = `ga_live_${randomBytes(24).toString('base64url')}`;
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    // Wipe any state a prior test run left behind on the shared dev DB.
    // Order matters — audit rows FK back to admin / api_key.
    await AppDataSource.query('TRUNCATE TABLE "api_key_audit", "admin_audit", "api_key", "admin" RESTART IDENTITY CASCADE');
    await AppDataSource.getRepository(AdminEntity).save({ name: BOOTSTRAP_ADMIN_NAME, key: adminKey, isActive: true });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
    await redis?.stop();
  });

  it('rejects an unauthenticated call to the gasless surface with 401', async () => {
    const res = await http.post('/gasless/transactions/estimate').send({});
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe(60001);
  });

  it('rejects an unauthenticated call to the admin surface with 401', async () => {
    const res = await http.get('/admin/api-keys');
    expect(res.status).toBe(401);
  });

  it('accepts the bootstrap admin and can mint an integrator key', async () => {
    const res = await http
      .post('/admin/api-keys')
      .set('x-admin-key', adminKey)
      .send({ clientName: 'acme', rateLimitRps: 10 });
    expect(res.status).toBe(201);
    expect(res.body?.data?.key).toMatch(/^gk_live_/);
    expect(res.body?.data?.isActive).toBe(true);
  });

  it('a valid integrator key gets past the guard and reaches the validation pipe', async () => {
    const mintRes = await http
      .post('/admin/api-keys')
      .set('x-admin-key', adminKey)
      .send({ clientName: 'client-A' });
    const integratorKey = mintRes.body.data.key as string;

    // Empty body will fail DTO validation (400) but that proves the guard passed.
    const res = await http.post('/gasless/transactions/estimate').set('x-api-key', integratorKey).send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('a deactivated key stops working immediately', async () => {
    const mintRes = await http
      .post('/admin/api-keys')
      .set('x-admin-key', adminKey)
      .send({ clientName: 'client-B' });
    const key = mintRes.body.data.key as string;
    const id = mintRes.body.data.id as string;

    const patchRes = await http
      .patch(`/admin/api-keys/${id}/active`)
      .set('x-admin-key', adminKey)
      .send({ isActive: false, reason: 'test rotation' });
    expect(patchRes.status).toBe(200);

    const gatedRes = await http.post('/gasless/transactions/estimate').set('x-api-key', key).send({});
    expect(gatedRes.status).toBe(401);
    expect(gatedRes.body?.error?.code).toBe(60001);
  });

  it('a random key is rejected as unauthorized', async () => {
    const res = await http
      .post('/gasless/transactions/estimate')
      .set('x-api-key', 'gk_live_notarealkey')
      .send({});
    expect(res.status).toBe(401);
  });

  it('deactivating the last active admin is refused (409)', async () => {
    // Look up the sole active admin and try to deactivate it.
    const list = await http.get('/admin/admins').set('x-admin-key', adminKey);
    const bootstrap = (list.body.data as Array<{ id: string; name: string }>).find((a) => a.name === BOOTSTRAP_ADMIN_NAME);
    expect(bootstrap).toBeDefined();

    const res = await http
      .patch(`/admin/admins/${bootstrap!.id}/active`)
      .set('x-admin-key', adminKey)
      .send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe(61002);
  });
});
