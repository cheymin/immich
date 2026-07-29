import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

// Lightweight single-process WebSocket adapter (no Redis pub/sub).
// The original implementation used @socket.io/redis-adapter to share state
// between the API and microservices workers. In the single-container build
// there is only one process, so the in-memory default adapter is sufficient.
export class WebSocketAdapter extends IoAdapter {
  constructor(private app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    return super.createIOServer(port, options);
  }
}
