import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- 类型定义 ---

/**
 * 传输数据类型
 */
export type DataType = 'string' | 'file';

/**
 * 基础传输数据结构
 */
export interface BaseData {
  type: DataType;
}

/**
 * 字符串数据结构
 */
export interface StringData extends BaseData {
  type: 'string';
  content: string;
}

/**
 * 文件数据结构 (客户端上传时使用)
 */
export interface FileData extends BaseData {
  type: 'file';
  content: Buffer; // 文件内容
  fileName: string;
  mimeType: string;
}

/**
 * 服务器端存储和广播的文件信息结构
 */
export interface StoredFileData extends BaseData {
  type: 'file';
  fileId: string; // 文件的唯一标识
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * 客户端上传的统一数据格式
 */
export type TransferData = StringData | FileData;

/**
 * 服务器端存储和广播的统一数据格式
 */
export type StoredData = StringData | StoredFileData;


/**
 * 房间模式：
 * 'singleton': 房间只保留最新的一条数据，新数据会覆盖旧数据。
 * 'live': 数据是实时的，服务器仅做转发，不保留历史记录。
 * 'history': [新增] 房间会保留所有历史数据，直到房间关闭。
 */
export type RoomMode = 'singleton' | 'live' | 'history'; // [修改] 添加 'history' 模式

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

  /**
   * 文件上传的存储目录。如果未提供，则不支持文件上传。
   */
  uploadDir?: string;

  /**
   * 允许上传的最大文件大小（以字节为单位）。
   * 默认为 100MB (1e8 字节), 与 maxHttpBufferSize 一致。
   */
  maxFileSize?: number;

  /**
   * 连接校验钩子函数。如果提供，将在每个新连接建立时调用。
   * @param socket 客户端 Socket 实例
   * @param next 回调函数。调用 next() 表示允许连接，调用 next(new Error('...')) 表示拒绝连接。
   */
  auth?: (socket: Socket, next: (err?: Error) => void) => void;
}

/**
 * 内部存储的房间数据结构
 */
interface RoomData {
  id: string;
  capacity: number;
  mode: RoomMode;
  clients: Set<string>; // 存储 socket.id
  // [修改] data 可以是单个对象，也可以是对象数组，以支持 history 模式
  data?: StoredData | StoredData[]; 
}

const DEFAULT_MAX_PUBLIC_HISTORY = 50;
const DEFAULT_MAX_FILE_SIZE = 1e8; // 100 MB

/**
 * FluxShareServer 类，用于创建和管理实时数据共享服务。
 */
export class FluxShareServer {
  public io: Server;
  private publicHistory: StoredData[] = [];
  private rooms: Map<string, RoomData> = new Map();
  private deletedFiles: Set<string> = new Set();
  private readonly maxPublicHistory: number;
  private readonly uploadDir?: string;
  private readonly maxFileSize: number;

  /**
   * 构造函数
   * @param server Node.js 的 http.Server 实例
   * @param options 配置选项
   */
  constructor(server: HttpServer, options: FluxShareOptions = {}) {
    this.maxPublicHistory = options.maxPublicHistory ?? DEFAULT_MAX_PUBLIC_HISTORY;
    this.uploadDir = options.uploadDir;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

    this.io = new Server(server, {
      cors: {
        origin: options.origin ?? "*",
      },
      maxHttpBufferSize: 1e8, // 100 MB
    });
    
    if (this.uploadDir) {
      fs.mkdir(this.uploadDir, { recursive: true })
        .catch(err => console.error('Failed to create upload directory:', err));
    }

    if (options.auth) {
      this.io.use(options.auth);
    } else {
      this.io.use((socket, next) => {
        console.log(`New connection from ${socket.id}, no auth provided.`);
        next();
      });
    }

    this.initializeListeners();
    console.log('✅ Flux-Share Server initialized.');
  }
  
  /**
   * 清理已被逻辑删除的物理文件。
   */
  public async cleanupDeletedFiles(): Promise<{ deleted: string[], failed: string[] }> {
    if (!this.uploadDir) {
      console.warn("Cleanup requested, but no 'uploadDir' is configured.");
      this.deletedFiles.clear();
      return { deleted: [], failed: [] };
    }
    
    const deleted: string[] = [];
    const failed: string[] = [];

    console.log(`Starting cleanup for ${this.deletedFiles.size} logically deleted files...`);

    for (const fileId of this.deletedFiles) {
      try {
        const filePath = path.join(this.uploadDir, fileId);
        await fs.unlink(filePath);
        deleted.push(fileId);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          deleted.push(fileId);
        } else {
          console.error(`Failed to delete file ${fileId}:`, error);
          failed.push(fileId);
        }
      }
    }
    
    for (const fileId of deleted) {
      this.deletedFiles.delete(fileId);
    }

    console.log(`Cleanup finished. Deleted: ${deleted.length}, Failed: ${failed.length}.`);
    return { deleted, failed };
  }


  /**
   * 处理上传的数据，根据类型进行不同操作
   */
  private async processUpload(data: TransferData): Promise<StoredData | null> {
    if (data.type === 'string') {
      return data;
    }

    if (data.type === 'file') {
      if (!this.uploadDir) {
        console.error('File upload failed: uploadDir is not configured.');
        return null;
      }
      if (data.content.length > this.maxFileSize) {
        console.error(`File upload failed: File size (${data.content.length} bytes) exceeds the limit of ${this.maxFileSize} bytes.`);
        return null;
      }

      const fileId = randomUUID();
      const filePath = path.join(this.uploadDir, fileId);

      try {
        await fs.writeFile(filePath, data.content);
        const storedFile: StoredFileData = {
          type: 'file',
          fileId: fileId,
          fileName: data.fileName,
          mimeType: data.mimeType,
          size: data.content.length,
        };
        return storedFile;
      } catch (error) {
        console.error('Failed to save uploaded file:', error);
        return null;
      }
    }

    return null;
  }

  /**
   * 初始化所有 socket.io 事件监听器
   */
  private initializeListeners(): void {
    this.io.on('connection', (socket: Socket) => {
      this.handlePublicFlux(socket);
      this.handlePrivateRooms(socket);
      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });
    });
  }

  /**
   * 处理所有与公共流相关的事件
   */
  private handlePublicFlux(socket: Socket): void {
    socket.emit('public:history', this.publicHistory);

    socket.on('public:upload', async (data: TransferData) => {
      const processedData = await this.processUpload(data);
      if (!processedData) return;

      this.publicHistory.push(processedData);
      if (this.publicHistory.length > this.maxPublicHistory) {
        const removedItem = this.publicHistory.shift();
        if (removedItem?.type === 'file') {
          this.deletedFiles.add(removedItem.fileId);
        }
      }
      this.io.emit('public:history', this.publicHistory);
    });

    socket.on('public:deleteLast', () => {
      if (this.publicHistory.length > 0) {
        const removedItem = this.publicHistory.pop();
        if (removedItem?.type === 'file') {
          this.deletedFiles.add(removedItem.fileId);
          console.log(`Logically deleted file: ${removedItem.fileId}`);
        }
        this.io.emit('public:history', this.publicHistory);
      }
    });
  }

  /**
   * 处理所有与私人房间相关的事件
   * @param socket 客户端 Socket 实例
   */
  private handlePrivateRooms(socket: Socket): void {
    socket.on('room:create', (options: RoomOptions, callback: (response: { success: boolean; roomId: string; message: string }) => void) => {
      const createResult = this.createPrivateRooms(options);
      callback(createResult);
    });

    socket.on('room:join', (roomId: string, callback: (response: { success: boolean; message: string; data?: StoredData | StoredData[] }) => void) => {
      console.log(`Client ${socket.id} is trying to join room ${roomId}`);
      const room = this.rooms.get(roomId);
      if (!room) {
        return callback({ success: false, message: 'Room not found.' });
      }
      if (room.clients.size >= room.capacity) {
        return callback({ success: false, message: 'Room is full.' });
      }
      
      socket.join(roomId);
      room.clients.add(socket.id);

      // [修改] 如果是 singleton 或 history 模式且已有数据，则发送给新加入者
      let responseData: StoredData | StoredData[] | undefined = undefined;
      if (room.mode === 'singleton' || room.mode === 'history') {
        responseData = room.data;
      }
      
      console.log(`Client ${socket.id} joined room ${roomId}`);
      callback({ success: true, message: `Successfully joined room '${roomId}'.`, data: responseData });
    });

    // [新增] 监听客户端主动请求历史记录的事件
    socket.on('room:history', (roomId: string, callback: (response: { success: boolean; message: string; data?: StoredData[] }) => void) => {
      console.log(`Client ${socket.id} requested history for room ${roomId}`);  
      const room = this.rooms.get(roomId);

        // 校验：房间是否存在
        if (!room) {
            return callback({ success: false, message: 'Room not found.' });
        }
        // 校验：客户端是否在该房间内
        if (!socket.rooms.has(roomId)) {
            return callback({ success: false, message: 'You are not a member of this room.' });
        }
        // 校验：房间是否是 history 模式
        if (room.mode !== 'history') {
            return callback({ success: false, message: 'Room is not in history mode.' });
        }

        // 校验通过，发送历史记录
        const historyData = Array.isArray(room.data) ? room.data : [];
        callback({ success: true, message: 'History retrieved successfully.', data: historyData });
    });

    socket.on('room:upload', async (payload: { roomId: string; data: TransferData }, callback: (response: { success: boolean; message: string; }) => void) => {
      const { roomId, data } = payload;
      const room = this.rooms.get(roomId);
      
      if (!room || !socket.rooms.has(roomId)) {
        return callback({ success: false, message: 'You are not in this room.' });
      }

      const processedData = await this.processUpload(data);
      if (!processedData) {
        return callback({ success: false, message: 'Failed to process upload.' });
      }

      if (room.mode === 'live') {
        socket.to(roomId).emit('room:data', processedData);
      } else if (room.mode === 'singleton') {
        if (room.data && (room.data as StoredFileData).type === 'file') {
            this.deletedFiles.add((room.data as StoredFileData).fileId);
            console.log(`Logically deleted file due to overwrite: ${(room.data as StoredFileData).fileId}`);
        }
        room.data = processedData;
        this.io.to(roomId).emit('room:data', room.data);
      } else if (room.mode === 'history') { // [新增] history 模式的逻辑
        if (!Array.isArray(room.data)) {
          // 安全检查，以防万一
          room.data = [];
        }
        room.data.push(processedData);
        // 只广播最新的数据给房间内所有人（包括发送者自己）
        this.io.to(roomId).emit('room:data', processedData);
      }

      callback({ success: true, message: 'Data sent successfully.' });
    });
  }
  
  /**
   * @description 创建一个私人房间
   * @param options 房间选项
   * @returns 创建结果
   * ```js
   * {
   *  success: boolean,
   *  roomId: string,
   *  message: string
   * }
   * ```
   */
  public createPrivateRooms(options: RoomOptions): { success: boolean, roomId: string, message: string } {
    if (this.rooms.has(options.roomId)) {
      return { success: false,roomId: '' , message: `Room '${options.roomId}' already exists.` };
    }
    const newRoom: RoomData = {
      id: options.roomId,
      capacity: options.capacity,
      mode: options.mode,
      clients: new Set(),
      // [修改] 根据模式初始化 data
      data: options.mode === 'history' ? [] : undefined,
    };

    this.rooms.set(options.roomId, newRoom);
    console.log(`Room created: ${options.roomId}`);
    return { success: true,roomId: options.roomId, message: `Room '${options.roomId}' created successfully.` }
  }

  /**
   * 处理客户端断开连接的清理工作
   * @param socket 客户端 Socket 实例
   */
  private handleDisconnect(socket: Socket): void {
    this.rooms.forEach((room) => {
      if (room.clients.has(socket.id)) {
        room.clients.delete(socket.id);
        console.log(`Client ${socket.id} left room ${room.id}`);
        if (room.clients.size === 0) {
          // [修改] 清理逻辑需要处理 history 模式
          if (room.mode === 'singleton' && room.data && (room.data as StoredFileData).type === 'file') {
            this.deletedFiles.add((room.data as StoredFileData).fileId);
            console.log(`Logically deleted file from empty room ${room.id}: ${(room.data as StoredFileData).fileId}`);
          } else if (room.mode === 'history' && Array.isArray(room.data)) {
            // [新增] 遍历 history 数组，逻辑删除所有文件
            for (const item of room.data) {
              if (item.type === 'file') {
                this.deletedFiles.add(item.fileId);
                console.log(`Logically deleted file from empty history room ${room.id}: ${item.fileId}`);
              }
            }
          }
          this.rooms.delete(room.id);
          console.log(`Room ${room.id} is empty and has been removed.`);
        }
      }
    });
  }
}