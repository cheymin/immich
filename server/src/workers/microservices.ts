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

  // In the lightweight single-container build, microservices runs in a Worker
  // thread and does not need to expose a TCP port — it processes jobs in
  // process via the in-memory queue. Binding an ephemeral listener inside a
  // Worker thread is also flaky in some hosted runtimes (HF Spaces) and can
  // cause the thread to exit silently. So we deliberately do NOT call
  // app.listen() here. The keepalive interval below holds the event loop.
  logger.log(`Immich Microservices is running [v${serverVersion}] [${environment}]`);

  // Keepalive: the in-process job queue (no Redis/BullMQ) dispatches via
  // setImmediate and holds no persistent handle. Without an explicit handle
  // the Worker thread's event loop drains and the thread exits with code 0,
  // tearing the container down via the supervisor. This interval guarantees
  // the worker stays up.
  setInterval(() => {}, 1 << 30);
}

if (!isMainThread) {
  bootstrap().catch((error) => {
    // Always surface bootstrap failures. Previously, ImmichStartupError was
    // swallowed (no console.error) and then rethrown, producing a silent
    // code-0 exit that hid the real cause. Log everything and exit non-zero.
    console.error('microservices bootstrap failed:', error);
    process.exit(1);
  });
}
