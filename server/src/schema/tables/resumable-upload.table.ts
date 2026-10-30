import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Int8,
  PrimaryColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { UserTable } from 'src/schema/tables/user.table';

@Table('resumable_upload')
@UpdatedAtTrigger('resumable_upload_updatedAt')
export class ResumableUploadTable {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE' })
  ownerId!: string;

  @Column()
  filename!: string;

  @Column({ type: 'bigint' })
  fileSize!: Int8;

  @Column({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'bigint', default: 0 })
  offset!: Generated<Int8>;

  @Column()
  tempPath!: string;

  @Column({ type: 'jsonb' })
  metadata!: Record<string, string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;

  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;
}
