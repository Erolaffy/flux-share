import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

// --- 类型定义 ---

/**
 * 房间模式：
 * 'singleton': 房间只保留最新的一条数据，新数据会覆盖旧数据。
 * 'live': 数据是实时的，服务器仅做转发，不保留历史记录。
 */
export type RoomMode = 'singleton' | 'live';

/**
 * 创建房间时的选项
 */
export interface RoomOptions {
  roomId: string;
  capacity: number;
  mode: RoomMode;
}

/**
 * FluxShareServer 的配置选项
 */
export interface FluxShareOptions {
  /**
   * 公共流保留的历史记录最大数量，默认为 50
   */
  maxPublicHistory?: number;

  /**
   * 允许的来源，默认为 '*'，表示允许所有来源。
   * 如果需要限制来源，请指定具体的来源，例如 'https://example.com'。
   */
  origin?: string | string[] | boolean;
}

/**
 * 内部存储的房间数据结构
 */
interface RoomData {
  id: string;
  capacity: number;
  mode: RoomMode;
  clients: Set<string>; // 存储 socket.id
  data?: any; // 用于存储数据
}

const DEFAULT_MAX_PUBLIC_HISTORY = 50;

/**
 * FluxShareServer 类，用于创建和管理实时数据共享服务。
 */
export class FluxShareServer {
  private io: Server;
  private publicHistory: any[] = [];
  private rooms: Map<string, RoomData> = new Map();
  private readonly maxPublicHistory: number;

  /**
   * 构造函数
   * @param server Node.js 的 http.Server 实例
   * @param options 配置选项
   */
  constructor(server: HttpServer, options: FluxShareOptions = {}) {
    this.maxPublicHistory = options.maxPublicHistory ?? DEFAULT_MAX_PUBLIC_HISTORY;

    this.io = new Server(server, {
      cors: {
        origin: options.origin ?? "*", // 方便测试，生产环境建议配置具体来源
      },
      // 允许传输大数据，例如文件
      maxHttpBufferSize: 1e8, // 100 MB
    });

    this.initializeListeners();
    console.log('✅ Flux-Share Server initialized.');
  }

  /**
   * 初始化所有 socket.io 事件监听器
   */
  private initializeListeners(): void {
    this.io.on('connection', (socket: Socket) => {
      // --- 公共剪切板逻辑 ---
      this.handlePublicFlux(socket);

      // --- 私人房间逻辑 ---
      this.handlePrivateRooms(socket);

      // --- 清理逻辑 ---
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  /**
   * 处理所有与公共流相关的事件
   * @param socket 客户端 Socket 实例
   */
  private handlePublicFlux(socket: Socket): void {
    // 1. 新客户端连接时，发送当前的公共历史记录
    socket.emit('public:history', this.publicHistory);

    // 2. 监听客户端上传数据
    socket.on('public:upload', (data: any) => {
      // console.log('Received public flux data:', data);
      // console.log('Received public flux data type:', typeof data);
      console.log(data.size / (1000*1000) + 'MB')
      this.publicHistory.push(data);
      // 如果历史记录超过上限，则移除最旧的一条
      if (this.publicHistory.length > this.maxPublicHistory) {
        this.publicHistory.shift();
      }
      // 向所有客户端广播最新的历史记录
      this.io.emit('public:history', this.publicHistory);
    });

    // 3. 监听客户端删除最后一条数据
    socket.on('public:deleteLast', () => {
      if (this.publicHistory.length > 0) {
        this.publicHistory.pop();
        // 向所有客户端广播最新的历史记录
        this.io.emit('public:history', this.publicHistory);
      }
    });
  }

  /**
   * 处理所有与私人房间相关的事件
   * @param socket 客户端 Socket 实例
   */
  private handlePrivateRooms(socket: Socket): void {
    // 1. 创建房间
    socket.on('room:create', (options: RoomOptions, callback: (response: { success: boolean; message: string }) => void) => {
      if (this.rooms.has(options.roomId)) {
        return callback({ success: false, message: `Room '${options.roomId}' already exists.` });
      }
      const newRoom: RoomData = {
        id: options.roomId,
        capacity: options.capacity,
        mode: options.mode,
        clients: new Set(),
        data: undefined,
      };
      this.rooms.set(options.roomId, newRoom);
      console.log(`Room created: ${options.roomId}`)
      callback({ success: true, message: `Room '${options.roomId}' created successfully.` });
    });

    // 2. 加入房间
    socket.on('room:join', (roomId: string, callback: (response: { success: boolean; message: string; data?: any }) => void) => {
      const room = this.rooms.get(roomId);
      if (!room) {
        return callback({ success: false, message: 'Room not found.' });
      }
      if (room.clients.size >= room.capacity) {
        return callback({ success: false, message: 'Room is full.' });
      }
      
      socket.join(roomId);
      room.clients.add(socket.id);

      let responseData: any = undefined;
      // 如果是 singleton 模式且已有数据，则发送给新加入者
      if (room.mode === 'singleton' && room.data) {
        responseData = room.data;
      }
      
      console.log(`Client ${socket.id} joined room ${roomId}`);
      callback({ success: true, message: `Successfully joined room '${roomId}'.`, data: responseData });
    });

    // 3. 在房间内上传数据
    socket.on('room:upload', (payload: { roomId: string; data: any }) => {
      const { roomId, data } = payload;
      console.log(`Received room data size: ${data.size / (1000*1000) + 'MB'}`);
      const room = this.rooms.get(roomId);
      
      // 确保该客户端确实在房间内
      if (!room || !socket.rooms.has(roomId)) {
        return; // 或者发送一个错误事件
      }

      if (room.mode === 'live') {
        // 'live' 模式：仅将数据广播给房间内其他成员
        socket.to(roomId).emit('room:data', data);
      } else if (room.mode === 'singleton') {
        // 'singleton' 模式：更新数据并广播给房间内所有成员
        room.data = data;
        this.io.to(roomId).emit('room:data', room.data);
      }
    });
  }
  
  /**
   * 处理客户端断开连接的清理工作
   * @param socket 客户端 Socket 实例
   */
  private handleDisconnect(socket: Socket): void {
    // 遍历所有房间，检查该客户端是否在其中
    this.rooms.forEach((room) => {
      if (room.clients.has(socket.id)) {
        room.clients.delete(socket.id);
        console.log(`Client ${socket.id} left room ${room.id}`);
        // 如果房间空了，可以选择销毁房间以释放内存
        if (room.clients.size === 0) {
          this.rooms.delete(room.id);
          console.log(`Room ${room.id} is empty and has been removed.`);
        }
      }
    });
  }
}