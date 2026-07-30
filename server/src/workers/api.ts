import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress, configureTelemetry } from 'src/app.common';
import { ApiModule } from 'src/app.module';
import { AppRepository } from 'src/repositories/app.repository';
import { ApiService } from 'src/services/api.service';

async function bootstrap() {
  process.title = 'immich-api';

  configureTelemetry();

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { bufferLogs: true });
  app.get(AppRepository).setCloseFn(() => app.close());

  void configureExpress(app, {
    ssr: ApiService,
  });
}

bootstrap().catch((error) => {
  // Always surface bootstrap failures — do not swallow startup errors.
  console.error('api bootstrap failed:', error);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
