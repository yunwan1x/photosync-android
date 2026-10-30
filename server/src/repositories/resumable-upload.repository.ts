import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema';
import { ResumableUploadTable } from 'src/schema/tables/resumable-upload.table';
import { asUuid } from 'src/utils/database';
import { isSqliteBackend } from 'src/utils/database-helpers';

@Injectable()
export class ResumableUploadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(dto: Insertable<ResumableUploadTable>) {
    return this.db.insertInto('resumable_upload').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  get(id: string, ownerId: string) {
    return this.db
      .selectFrom('resumable_upload')
      .selectAll()
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  async append(
    id: string,
    ownerId: string,
    expectedOffset: number,
    write: (session: { tempPath: string; fileSize: number }) => Promise<number>,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const sessionQuery = tx
        .selectFrom('resumable_upload')
        .selectAll()
        .where('id', '=', asUuid(id))
        .where('ownerId', '=', ownerId);
      const session = await (isSqliteBackend() ? sessionQuery : sessionQuery.forUpdate()).executeTakeFirst();
      if (!session) {
        return;
      }
      if (Number(session.offset) !== expectedOffset) {
        return { session, offsetMismatch: true as const };
      }

      const nextOffset = await write(session);
      const updated = await tx
        .updateTable('resumable_upload')
        .set({
          offset: nextOffset,
          updatedAt: new Date(),
          updateId: sql`immich_uuid_v7()`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .where('id', '=', asUuid(id))
        .returningAll()
        .executeTakeFirstOrThrow();
      return { session: updated, offsetMismatch: false as const };
    });
  }

  delete(id: string, ownerId: string) {
    return this.db
      .deleteFrom('resumable_upload')
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', ownerId)
      .returningAll()
      .executeTakeFirst();
  }

  deleteExpired() {
    return this.db.deleteFrom('resumable_upload').where('expiresAt', '<', new Date()).returningAll().execute();
  }
}
