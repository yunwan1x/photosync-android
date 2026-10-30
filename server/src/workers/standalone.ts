import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { isMainThread } from 'node:worker_threads';
import { configureExpress, configureTelemetry } from 'src/app.common';
import { StandaloneModule } from 'src/app.module';
import { AppRepository } from 'src/repositories/app.repository';
import { ApiService } from 'src/services/api.service';
import { isStartUpError } from 'src/utils/misc';

export async function bootstrap() {
  process.title = 'immich-standalone';
  configureTelemetry();

  const app = await NestFactory.create<NestExpressApplication>(StandaloneModule, { bufferLogs: true });
  app.get(AppRepository).setCloseFn(() => app.close());

  await configureExpress(app, { ssr: ApiService });
}

if (!isMainThread) {
  bootstrap().catch((error) => {
    if (!isStartUpError(error)) {
      console.error(error);
    }
    throw error;
  });
}
