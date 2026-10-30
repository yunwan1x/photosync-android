import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto';
import { ResumableUploadService } from 'src/services/resumable-upload.service';
import { authStub } from 'test/fixtures/auth.stub';

describe('ResumableUploadService', () => {
  let directory: string;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let assetMediaService: Record<string, ReturnType<typeof vi.fn>>;
  let sut: ResumableUploadService;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'immich-resumable-'));
    repository = {
      create: vi.fn(),
      get: vi.fn(),
      append: vi.fn(),
      delete: vi.fn(),
      deleteExpired: vi.fn().mockResolvedValue([]),
    };
    assetMediaService = {
      getUploadAssetIdByChecksum: vi.fn(),
      validateUploadQuota: vi.fn(),
      canUploadFile: vi.fn(),
      getUploadFolder: vi.fn().mockReturnValue(directory),
      getUploadFilename: vi.fn().mockReturnValue('upload.mp4'),
      uploadAsset: vi.fn(),
    };
    sut = new ResumableUploadService(repository as never, assetMediaService as never);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns an existing asset without creating a session', async () => {
    assetMediaService.getUploadAssetIdByChecksum.mockResolvedValue({
      id: 'asset-id',
      status: AssetMediaStatus.DUPLICATE,
    });

    await expect(sut.create(authStub.user1, createDto())).resolves.toEqual({
      assetId: 'asset-id',
      status: AssetMediaStatus.DUPLICATE,
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('creates a durable empty partial file and database session', async () => {
    repository.create.mockImplementation((value) => ({ ...value, offset: 0 }));

    const result = await sut.create(authStub.user1, createDto());

    expect(result).toMatchObject({ offset: 0 });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: authStub.user1.user.id }));
    await expect(fs.stat(path.join(directory, 'upload.mp4.part'))).resolves.toMatchObject({ size: 0 });
  });

  it('reports the server offset when a client sends a stale offset', async () => {
    repository.append.mockResolvedValue({ session: { offset: 8 }, offsetMismatch: true });

    const promise = sut.append(authStub.user1, 'upload-id', 0, Buffer.from('chunk'));
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({ getStatus: expect.any(Function) });
  });

  it('writes a chunk at the locked offset and advances it', async () => {
    const tempPath = path.join(directory, 'upload.mp4.part');
    await fs.writeFile(tempPath, Buffer.alloc(10));
    repository.append.mockImplementation(async (_id, _ownerId, offset, write) => {
      const nextOffset = await write({ tempPath, fileSize: 10 });
      return { session: { id: 'upload-id', offset: nextOffset }, offsetMismatch: false };
    });

    await expect(sut.append(authStub.user1, 'upload-id', 2, Buffer.from('abcd'))).resolves.toEqual({
      id: 'upload-id',
      offset: 6,
    });
    await expect(fs.readFile(tempPath)).resolves.toEqual(Buffer.from([0, 0, 97, 98, 99, 100, 0, 0, 0, 0]));
  });

  it('commits a verified upload through the normal asset service', async () => {
    const bytes = Buffer.from('video bytes');
    const tempPath = path.join(directory, 'upload.mp4.part');
    await fs.writeFile(tempPath, bytes);
    repository.get.mockResolvedValue({
      id: 'upload-id',
      ownerId: authStub.user1.user.id,
      filename: 'video.mp4',
      fileSize: bytes.length,
      offset: bytes.length,
      checksum: createHash('sha1').update(bytes).digest(),
      tempPath,
      metadata: {
        filename: 'video.mp4',
        fileCreatedAt: new Date().toISOString(),
        fileModifiedAt: new Date().toISOString(),
      },
    });
    assetMediaService.uploadAsset.mockResolvedValue({ id: 'asset-id', status: AssetMediaStatus.CREATED });

    await expect(sut.complete(authStub.user1, 'upload-id')).resolves.toEqual({
      id: 'asset-id',
      status: AssetMediaStatus.CREATED,
    });
    expect(assetMediaService.uploadAsset).toHaveBeenCalledWith(
      authStub.user1,
      expect.objectContaining({ filename: 'video.mp4' }),
      expect.objectContaining({ originalPath: path.join(directory, 'upload.mp4') }),
    );
    expect(repository.delete).toHaveBeenCalledWith('upload-id', authStub.user1.user.id);
  });

  it('rejects and removes a completed upload with the wrong checksum', async () => {
    const tempPath = path.join(directory, 'upload.mp4.part');
    await fs.writeFile(tempPath, 'actual bytes');
    repository.get.mockResolvedValue({
      id: 'upload-id',
      ownerId: authStub.user1.user.id,
      filename: 'video.mp4',
      fileSize: 12,
      offset: 12,
      checksum: createHash('sha1').update('different bytes').digest(),
      tempPath,
      metadata: {
        fileCreatedAt: new Date().toISOString(),
        fileModifiedAt: new Date().toISOString(),
      },
    });
    repository.delete.mockResolvedValue({ tempPath });

    await expect(sut.complete(authStub.user1, 'upload-id')).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(fs.stat(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

const createDto = () => ({
  filename: 'video.mp4',
  fileSize: 1024,
  checksum: createHash('sha1').update('test').digest('base64'),
  metadata: {
    filename: 'video.mp4',
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
  },
});
