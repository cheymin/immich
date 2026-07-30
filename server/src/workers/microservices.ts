import { NestFactory } from '@nestjs/core';
import { isMainThread } from 'node:worker_threads';
import { MicroservicesModule } from 'src/app.module';
import { serverVersion } from 'src/constants';
import { WebSocketAdapter } from 'src/middleware/websocket.adapter';
import { AppRepository } from 'src/repositories/app.repository';
import { ConfigRepository } from 'src/repositories/config.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { bootstrapTelemetry } from 'src/repositories/telemetry.repository';

export async function bootstrap() {
  // Register a keepalive handle BEFORE any await. The microservices worker runs
  // in a Worker thread and does not call app.listen() (no socket handle), and
  // better-sqlite3 is synchronous (no libuv handle). During NestFactory.create()
  // the AppBootstrap handlers run; once they complete there is a window with no
  // pending handles, which causes the Worker thread's event loop to drain and
  // the thread to exit with code 0 — before the keepalive at the end of this
  // function could be registered. Installing it first eliminates that window.
  const keepalive = setInterval(() => {}, 1 << 30);

  const { telemetry } = new ConfigRepository().getEnv();
  if (telemetry.metrics.size > 0) {
    bootstrapTelemetry(telemetry.microservicesPort);
  }

  const app = await NestFactory.create(MicroservicesModule, { bufferLogs: true });
  const logger = await app.resolve(LoggingRepository);
  const configRepository = app.get(ConfigRepository);
  app.get(AppRepository).setCloseFn(() => app.close());

  const { environment } = configRepository.getEnv();

  logger.setContext('Bootstrap');
  app.useLogger(logger);
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  // Explicitly initialise the app so onModuleInit runs and the AppBootstrap
  // event is emitted (DatabaseService schema init, StorageService mount
  // checks, QueueService setup, etc.). We deliberately do NOT call
  // app.listen() — the microservices worker runs in a Worker thread and does
  // not need a TCP port (jobs are processed in-process via the memory queue),
  // and binding an ephemeral listener inside a Worker thread is flaky in some
  // hosted runtimes. The keepalive interval below holds the event loop.
  await app.init();
  logger.log(`Immich Microservices is running [v${serverVersion}] [${environment}]`);

  // keepalive was registered at the top of bootstrap(); leave it running for
  // the lifetime of the worker. It is intentionally never cleared.
  void keepalive;
}

if (!isMainThread) {
  // Surface anything that escapes the promise chain. Without these, an
  // unhandled rejection in a Worker thread can cause a silent exit.
  process.on('unhandledRejection', (reason) => {
    console.error('microservices unhandledRejection:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('microservices uncaughtException:', err);
    process.exit(1);
  });

  bootstrap().catch((error) => {
    // Always surface bootstrap failures. Previously, ImmichStartupError was
    // swallowed (no console.error) and then rethrown, producing a silent
    // code-0 exit that hid the real cause. Log everything and exit non-zero.
    console.error('microservices bootstrap failed:', error);
    process.exit(1);
  });
}
