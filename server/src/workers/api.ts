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

  // MUST be awaited — configureExpress calls app.listen(port) internally.
  // The original code used `void configureExpress(...)`, which let bootstrap()
  // resolve before listen() ever ran. In a forked child process the event loop
  // then drained and the process exited with code 0 before the server could
  // bind, killing the container via the supervisor's process.exit(0).
  await configureExpress(app, {
    ssr: ApiService,
  });
}

bootstrap().catch((error) => {
  // Always surface bootstrap failures — do not swallow startup errors.
  console.error('api bootstrap failed:', error);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
