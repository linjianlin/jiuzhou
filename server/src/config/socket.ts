import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

let io: Server;

// 初始化Socket.io
export const initSocket = (
  httpServer: HttpServer,
  corsOrigin?:
    | string
    | string[]
    | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void)
): Server => {
  io = new Server(httpServer, {
    cors: {
      origin: corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:6010',
      credentials: true,
    },
  });

  io.on('connection', (socket: Socket) => {
    // 加入房间
    socket.on('join:room', (roomId: string) => {
      socket.join(roomId);
    });

    // 离开房间
    socket.on('leave:room', (roomId: string) => {
      socket.leave(roomId);
    });

    // 聊天消息
    socket.on('chat:send', (data: { channel: string; content: string; sender: string }) => {
      io.emit('chat:message', {
        ...data,
        timestamp: Date.now(),
      });
    });

    // 断开连接
    socket.on('disconnect', () => {
    });
  });

  console.log('Socket.io 初始化完成');
  return io;
};

// 获取Socket.io实例
export const getIO = (): Server => {
  if (!io) {
    throw new Error('Socket.io 未初始化');
  }
  return io;
};

export default { initSocket, getIO };
