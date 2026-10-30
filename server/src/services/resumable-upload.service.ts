import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { AssetMediaResponseDto } from 'src/dtos/asset-media-response.dto';
import { AssetMediaCreateDto, ResumableUploadCreateDto, UploadFieldName } from 'src/dtos/asset-media.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility } from 'src/enum';
import { ResumableUploadRepository } from 'src/repositories/resumable-upload.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { UploadFile } from 'src/types';
import { fromChecksum } from 'src/utils/request';

@Injectable()
export class ResumableUploadService {
  constructor(
    private repository: ResumableUploadRepository,
    private assetMediaService: AssetMediaService,
  ) {}

  async create(auth: AuthDto, dto: ResumableUploadCreateDto) {
    const duplicate = await this.assetMediaService.getUploadAssetIdByChecksum(auth, dto.checksum);
    if (duplicate) {
      return { assetId: duplicate.id, status: duplicate.status };
    }

    const checksum = fromChecksum(dto.checksum);
    if (checksum.length !== 20) {
      throw new BadRequestException('Checksum must be a SHA1 digest');
    }
    this.assetMediaService.validateUploadQuota(auth, dto.fileSize);

    const id = randomUUID();
    const file: UploadFile = {
      uuid: id,
      checksum,
      originalPath: '',
      originalName: dto.filename,
      size: dto.fileSize,
    };
    const uploadRequest = {
      auth,
      fieldName: UploadFieldName.ASSET_DATA,
      file,
      body: { filename: dto.filename },
    };
    this.assetMediaService.canUploadFile(uploadRequest);
    const folder = this.assetMediaService.getUploadFolder(uploadRequest);
    const finalName = this.assetMediaService.getUploadFilename(uploadRequest);
    const tempPath = `${folder}/${finalName}.part`;

    await this.cleanupExpired();
    await fs.writeFile(tempPath, Buffer.alloc(0), { flag: 'wx' });
    try {
      const session = await this.repository.create({
        id,
        ownerId: auth.user.id,
        filename: dto.filename,
        fileSize: dto.fileSize,
        checksum,
        offset: 0,
        tempPath,
        metadata: dto.metadata,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      });
      return { id: session.id, offset: Number(session.offset), expiresAt: session.expiresAt };
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  async get(auth: AuthDto, id: string) {
    const session = await this.repository.get(id, auth.user.id);
    if (!session || new Date(session.expiresAt) <= new Date()) {
      throw new NotFoundException('Upload session not found or expired');
    }
    return {
      id: session.id,
      offset: Number(session.offset),
      fileSize: Number(session.fileSize),
      expiresAt: session.expiresAt,
    };
  }

  async append(auth: AuthDto, id: string, expectedOffset: number, chunk: Buffer) {
    if (chunk.length === 0) {
      throw new BadRequestException('Upload chunk is empty');
    }
    if (chunk.length > MAX_CHUNK_SIZE) {
      throw new PayloadTooLargeException(`Upload chunk exceeds ${MAX_CHUNK_SIZE} bytes`);
    }

    const result = await this.repository.append(id, auth.user.id, expectedOffset, async (session) => {
      const fileSize = Number(session.fileSize);
      if (expectedOffset + chunk.length > fileSize) {
        throw new BadRequestException('Upload chunk exceeds declared file size');
      }
      const handle = await fs.open(session.tempPath, 'r+');
      try {
        const { bytesWritten } = await handle.write(chunk, 0, chunk.length, expectedOffset);
        if (bytesWritten !== chunk.length) {
          throw new Error('Could not persist the complete upload chunk');
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      return expectedOffset + chunk.length;
    });

    if (!result) {
      throw new NotFoundException('Upload session not found');
    }
    if (result.offsetMismatch) {
      throw new ConflictException({ message: 'Upload offset does not match', offset: Number(result.session.offset) });
    }
    return { id: result.session.id, offset: Number(result.session.offset) };
  }

  async complete(auth: AuthDto, id: string): Promise<AssetMediaResponseDto> {
    const session = await this.repository.get(id, auth.user.id);
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (Number(session.offset) !== Number(session.fileSize)) {
      throw new ConflictException({ message: 'Upload is incomplete', offset: Number(session.offset) });
    }

    const metadata = session.metadata;
    const fileCreatedAt = parseDate(metadata.fileCreatedAt, 'fileCreatedAt');
    const fileModifiedAt = parseDate(metadata.fileModifiedAt, 'fileModifiedAt');
    const createDto: AssetMediaCreateDto = {
      filename: metadata.filename || session.filename,
      fileCreatedAt,
      fileModifiedAt,
      duration: metadata.duration ? Number(metadata.duration) : undefined,
      isFavorite: metadata.isFavorite === 'true',
      visibility: metadata.visibility as AssetVisibility | undefined,
      livePhotoVideoId: metadata.livePhotoVideoId || undefined,
      metadata: metadata.metadata ? JSON.parse(metadata.metadata) : undefined,
      assetData: undefined,
    };

    const checksum = await hashFile(session.tempPath);
    if (!checksum.equals(session.checksum)) {
      await this.abort(auth, id);
      throw new UnprocessableEntityException('Uploaded file checksum does not match');
    }

    const finalPath = session.tempPath.replace(/\.part$/, '');
    await fs.rename(session.tempPath, finalPath);
    const file: UploadFile = {
      uuid: session.id,
      checksum: session.checksum,
      originalPath: finalPath,
      originalName: session.filename,
      size: Number(session.fileSize),
    };

    const response = await this.assetMediaService.uploadAsset(auth, createDto, file);
    await this.repository.delete(id, auth.user.id);
    return response;
  }

  async abort(auth: AuthDto, id: string) {
    const session = await this.repository.delete(id, auth.user.id);
    if (session) {
      await fs.rm(session.tempPath, { force: true });
    }
  }

  private async cleanupExpired() {
    const expired = await this.repository.deleteExpired();
    await Promise.all(expired.map((session) => fs.rm(session.tempPath, { force: true })));
  }
}

const hashFile = (path: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest()));
  });

const parseDate = (value: string | undefined, field: string) => {
  const date = value ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date`);
  }
  return date;
};

const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
