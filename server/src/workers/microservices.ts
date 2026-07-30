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

  const { environment, host } = configRepository.getEnv();

  logger.setContext('Bootstrap');
  app.useLogger(logger);
  app.useWebSocketAdapter(new WebSocketAdapter(app));

  logger.log(`Immich Microservices listening on ${host ?? '*'}:0`);
  await (host ? app.listen(0, host) : app.listen(0));

  logger.log(`Immich Microservices is running [v${serverVersion}] [${environment}] `);

  // Keepalive: the in-process job queue (no Redis/BullMQ) dispatches via
  // setImmediate and holds no persistent handle. app.listen(0) binds an
  // ephemeral server which, in some hosted runtimes (e.g. HF Spaces), does not
  // reliably keep the Worker thread's event loop alive — causing a silent
  // code-0 exit immediately after bootstrap. An unref'd-never interval
  // guarantees the worker stays up.
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
