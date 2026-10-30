import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  ParseFilePipe,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
} from 'src/dtos/asset-media-response.dto';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  ResumableUploadCreateDto,
} from 'src/dtos/asset-media.dto';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { ApiTag, ImmichHeader, Permission, RouteKey } from 'src/enum';
import { AssetUploadInterceptor } from 'src/middleware/asset-upload.interceptor';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { FileUploadInterceptor, getFiles } from 'src/middleware/file-upload.interceptor';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { AssetMediaService } from 'src/services/asset-media.service';
import { ResumableUploadService } from 'src/services/resumable-upload.service';
import { UploadFiles } from 'src/types';
import { ImmichFileResponse, sendFile } from 'src/utils/file';
import { FileNotEmptyValidator, UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetMediaController {
  constructor(
    private logger: LoggingRepository,
    private service: AssetMediaService,
    private resumableUploadService: ResumableUploadService,
  ) {}

  @Post('resumable')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Create resumable asset upload',
    description: 'Creates an upload session for an asset that will be sent in ordered chunks.',
    history: new HistoryBuilder().added('v3'),
  })
  createResumableUpload(@Auth() auth: AuthDto, @Body() dto: ResumableUploadCreateDto) {
    return this.resumableUploadService.create(auth, dto);
  }

  @Get('resumable/:id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Get resumable asset upload',
    description: 'Returns the durable server offset for an upload session.',
    history: new HistoryBuilder().added('v3'),
  })
  getResumableUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.resumableUploadService.get(auth, id);
  }

  @Patch('resumable/:id')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiConsumes('application/offset+octet-stream')
  @Endpoint({
    summary: 'Append resumable asset upload chunk',
    description: 'Appends one chunk at the exact offset supplied in the Upload-Offset header.',
    history: new HistoryBuilder().added('v3'),
  })
  async appendResumableUpload(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Headers('upload-offset') uploadOffset: string | undefined,
    @Req() req: Request,
  ) {
    const offset = Number(uploadOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new BadRequestException('Upload-Offset must be a non-negative integer');
    }
    const chunk = await readUploadChunk(req);
    return this.resumableUploadService.append(auth, id, offset, chunk);
  }

  @Post('resumable/:id/complete')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Complete resumable asset upload',
    description: 'Verifies and commits a fully uploaded asset.',
    history: new HistoryBuilder().added('v3'),
  })
  completeResumableUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.resumableUploadService.complete(auth, id);
  }

  @Delete('resumable/:id')
  @Authenticated({ permission: Permission.AssetUpload })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Abort resumable asset upload',
    description: 'Deletes an upload session and its partial file.',
    history: new HistoryBuilder().added('v3'),
  })
  abortResumableUpload(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto) {
    return this.resumableUploadService.abort(auth, id);
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
  @UseInterceptors(AssetUploadInterceptor, FileUploadInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: ImmichHeader.Checksum,
    description: 'sha1 checksum that can be used for duplicate detection before the file is uploaded',
    required: false,
  })
  @ApiBody({ description: 'Asset Upload Information', type: AssetMediaCreateDto })
  @ApiResponse({
    status: 200,
    description: 'Asset is a duplicate',
    type: AssetMediaResponseDto,
  })
  @ApiResponse({
    status: 201,
    description: 'Asset uploaded successfully',
    type: AssetMediaResponseDto,
  })
  @Endpoint({
    summary: 'Upload asset',
    description: 'Uploads a new asset to the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async uploadAsset(
    @Auth() auth: AuthDto,
    @UploadedFiles(new ParseFilePipe({ validators: [new FileNotEmptyValidator(['assetData'])] })) files: UploadFiles,
    @Body() dto: AssetMediaCreateDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AssetMediaResponseDto> {
    const { file, sidecarFile } = getFiles(files);
    const responseDto = await this.service.uploadAsset(auth, dto, file, sidecarFile);

    if (responseDto.status === AssetMediaStatus.DUPLICATE) {
      res.status(HttpStatus.OK);
    }

    return responseDto;
  }

  @Get(':id/original')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Download original asset',
    description: 'Downloads the original file of the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async downloadAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetDownloadOriginalDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.downloadOriginal(auth, id, dto), this.logger);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'View asset thumbnail',
    description:
      'Retrieve the thumbnail image for the specified asset. Viewing the fullsize thumbnail might redirect to downloadAsset, which requires a different permission.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async viewAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: AssetMediaOptionsDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    if (dto.size === AssetMediaSize.Original) {
      this.logger.deprecate(
        'Calling the thumbnail endpoint with size=original is deprecated. Use the :id/original endpoint instead',
      );
      const [_, reqSearch] = req.url.split('?');
      const redirSearchParams = new URLSearchParams(reqSearch);
      redirSearchParams.delete('size');
      return res.redirect('original' + '?' + redirSearchParams.toString());
    }

    const viewThumbnailRes = await this.service.viewThumbnail(auth, id, dto);

    if (viewThumbnailRes instanceof ImmichFileResponse) {
      await sendFile(res, next, () => Promise.resolve(viewThumbnailRes), this.logger);
    } else {
      // viewThumbnailRes is a AssetMediaRedirectResponse
      // which redirects to the original asset or a specific size to make better use of caching
      const { targetSize } = viewThumbnailRes;
      const [reqPath, reqSearch] = req.url.split('?');
      let redirPath: string;
      const redirSearchParams = new URLSearchParams(reqSearch);
      if (targetSize === 'original') {
        // relative path to this.downloadAsset
        redirPath = 'original';
        redirSearchParams.delete('size');
      } else if (Object.values(AssetMediaSize).includes(targetSize)) {
        redirPath = reqPath;
        redirSearchParams.set('size', targetSize);
      } else {
        throw new Error('Invalid targetSize: ' + targetSize);
      }
      const finalRedirPath = redirPath + '?' + redirSearchParams.toString();
      return res.redirect(finalRedirPath);
    }
  }

  @Get(':id/video/playback')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'Play asset video',
    description: 'Streams the video file for the specified asset. This endpoint also supports byte range requests.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async playAssetVideo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.playbackVideo(auth, id), this.logger);
  }

  @Post('bulk-upload-check')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Check bulk upload',
    description: 'Determine which assets have already been uploaded to the server based on their SHA1 checksums.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.OK)
  checkBulkUpload(
    @Auth() auth: AuthDto,
    @Body() dto: AssetBulkUploadCheckDto,
  ): Promise<AssetBulkUploadCheckResponseDto> {
    return this.service.bulkUploadCheck(auth, dto);
  }
}

const readUploadChunk = async (request: Request) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024 * 1024) {
      throw new PayloadTooLargeException('Upload chunk is too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
};
