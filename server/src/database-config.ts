import { DatabaseConnectionParams } from '@immich/sql-tools';

export const DATABASE_BACKENDS = ['postgres', 'sqlite'] as const;
export type DatabaseBackend = (typeof DATABASE_BACKENDS)[number];

export type PostgresDatabaseConfig = DatabaseConnectionParams & {
  backend?: 'postgres';
};

export type SqliteDatabaseConfig = {
  backend: 'sqlite';
  path: string;
};

export type ImmichDatabaseConfig = PostgresDatabaseConfig | SqliteDatabaseConfig;

export const isSqliteConfig = (config: ImmichDatabaseConfig): config is SqliteDatabaseConfig =>
  config.backend === 'sqlite';
