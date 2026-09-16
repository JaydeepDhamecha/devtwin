/** PostgreSQL service detector. */

import { ServiceDetector } from './base.js';

export class PostgresDetector extends ServiceDetector {
  readonly name = 'postgresql';
  readonly defaultPort = 5432;
  override readonly envVarPatterns = [
    '^POSTGRES',
    '^PG(HOST|PORT|USER|PASSWORD|DATABASE)$',
    '^DATABASE_URL$',
  ];
  override readonly dependencyNames = [
    'psycopg2',
    'psycopg2-binary',
    'psycopg',
    'pg',
    'asyncpg',
    'postgres',
  ];
  override readonly composeImageHints = ['postgres', 'postgresql', 'timescale'];
  override readonly readmeKeywords = ['postgres', 'postgresql'];
}
