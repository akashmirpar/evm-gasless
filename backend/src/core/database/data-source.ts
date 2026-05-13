import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';

import { SnakeNamingStrategy } from '../../common/utils/snake_naming.strategy';

loadDotenv();

function num(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.length > 0) {
    const parsed = Number(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function str(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.length > 0) return v;
  return fallback;
}

export function buildDataSourceOptions(): DataSourceOptions {
  const rootDir = __dirname;
  const baseDir = join(rootDir, '..', '..');
  return {
    type: 'postgres',
    host: str(process.env.DATABASE_POSTGRES_HOST, '127.0.0.1'),
    port: num(process.env.DATABASE_POSTGRES_PORT, 5432),
    username: str(process.env.DATABASE_POSTGRES_USERNAME, 'gasless'),
    password: str(process.env.DATABASE_POSTGRES_PASSWORD, 'gasless'),
    database: str(process.env.DATABASE_POSTGRES_DATABASE, 'gasless'),
    entities: [join(baseDir, '**', '*.entity.{ts,js}'), join(baseDir, '**', '*.view.{ts,js}')],
    migrations: [join(rootDir, 'migrations', '*.{ts,js}')],
    migrationsTableName: 'typeorm_migrations',
    migrationsRun: true,
    synchronize: false,
    namingStrategy: new SnakeNamingStrategy(),
    extra: {
      max: 25,
      min: 5,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 30_000,
    },
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
