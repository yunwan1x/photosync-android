import {
  ASSET_CHECKSUM_CONSTRAINT,
  isAssetChecksumConstraint,
  isSharedLinkSlugConstraint,
  isVideoStreamSessionPkConstraint,
  VIDEO_STREAM_SESSION_PK_CONSTRAINT,
} from 'src/utils/database';

describe('database constraint detection', () => {
  it('recognizes PostgreSQL and SQLite asset checksum constraints', () => {
    expect(isAssetChecksumConstraint({ constraint_name: ASSET_CHECKSUM_CONSTRAINT })).toBe(true);
    expect(
      isAssetChecksumConstraint({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'UNIQUE constraint failed: asset.ownerId, asset.checksum',
      }),
    ).toBe(true);
    expect(
      isAssetChecksumConstraint({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'UNIQUE constraint failed: asset.ownerId, asset.libraryId, asset.checksum',
      }),
    ).toBe(true);
  });

  it('recognizes PostgreSQL and SQLite video stream session constraints', () => {
    expect(isVideoStreamSessionPkConstraint({ constraint_name: VIDEO_STREAM_SESSION_PK_CONSTRAINT })).toBe(true);
    expect(
      isVideoStreamSessionPkConstraint({
        code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
        message: 'UNIQUE constraint failed: video_stream_session.id',
      }),
    ).toBe(true);
  });

  it('recognizes PostgreSQL and SQLite shared-link slug constraints', () => {
    expect(isSharedLinkSlugConstraint({ constraint_name: 'shared_link_slug_uq' })).toBe(true);
    expect(
      isSharedLinkSlugConstraint({
        code: 'SQLITE_CONSTRAINT_UNIQUE',
        message: 'UNIQUE constraint failed: shared_link.slug',
      }),
    ).toBe(true);
    expect(isSharedLinkSlugConstraint(new Error('UNIQUE constraint failed: shared_link.slug'))).toBe(false);
  });
});
