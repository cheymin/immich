import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureExpress, configureTelemetry } from 'src/app.common';
import { ApiModule } from 'src/app.module';
import { AppRepository } from 'src/repositories/app.repository';
import { ApiService } from 'src/services/api.service';

async function bootstrap() {
  process.title = 'immich-api';

  // Safety-net keepalive, registered before any await. The API worker is a
  // forked child process and ultimately holds the event loop via the
  // app.listen(port) socket — but there is a window during NestFactory.create()
  // (before listen binds) where, with better-sqlite3 being synchronous, no
  // libuv handle is held and the process could exit with code 0. This interval
  // closes that window; it is harmless once the server socket takes over.
  const keepalive = setInterval(() => {}, 1 << 30);

  configureTelemetry();

  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { bufferLogs: true });
  app.get(AppRepository).setCloseFn(() => app.close());

  // MUST be awaited — configureExpress calls app.listen(port) internally.
  // The original code used `void configureExpress(...)`, which let bootstrap()
  // resolve before listen() ran. In a forked child process the event loop
  // then drained and the process exited with code 0 before the server could
  // bind, killing the container via the supervisor's process.exit(0).
  await configureExpress(app, {
    ssr: ApiService,
  });

  // Server socket is now holding the event loop; the keepalive is no longer
  // needed but is left running as a cheap safety net.
  void keepalive;
}

// Surface anything that escapes the promise chain.
process.on('unhandledRejection', (reason) => {
  console.error('api unhandledRejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('api uncaughtException:', err);
  process.exit(1);
});

bootstrap().catch((error) => {
  // Always surface bootstrap failures — do not swallow startup errors.
  console.error('api bootstrap failed:', error);
  // eslint-disable-next-line unicorn/no-process-exit
  process.exit(1);
});
