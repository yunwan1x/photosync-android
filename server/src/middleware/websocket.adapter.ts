import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { ServerOptions } from 'socket.io';
import { ConfigRepository } from 'src/repositories/config.repository';

export class WebSocketAdapter extends IoAdapter {
  constructor(private app: INestApplicationContext) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const { redis, redisBackend } = this.app.get(ConfigRepository).getEnv();
    const server = super.createIOServer(port, options);
    if (redisBackend === 'memory') {
      return server;
    }
    const pubClient = new Redis(redis);
    const subClient = pubClient.duplicate();
    server.adapter(createAdapter(pubClient, subClient));
    return server;
  }
}
