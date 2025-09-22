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
  data?: StoredData; // 用于存储数据 (使用统一格式)
}

const DEFAULT_MAX_PUBLIC_HISTORY = 50;
const DEFAULT_MAX_FILE_SIZE = 1e8; // 100 MB

/**
 * FluxShareServer 类，用于创建和管理实时数据共享服务。
 */
export class FluxShareServer {
  private io: Server;
  private publicHistory: StoredData[] = [];
  private rooms: Map<string, RoomData> = new Map();
  private deletedFiles: Set<string> = new Set(); // 存储被逻辑删除的文件的 fileId
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

    // 如果提供了 uploadDir，确保目录存在
    if (this.uploadDir) {
      fs.mkdir(this.uploadDir, { recursive: true })
        .catch(err => console.error('Failed to create upload directory:', err));
    }

    // 设置连接校验中间件
    if (options.auth) {
      this.io.use(options.auth);
    } else {
      // 默认允许所有连接
      this.io.use((socket, next) => {
        // 在这里可以添加未来的默认校验逻辑
        console.log(`New connection from ${socket.id}, no auth provided.`);
        next();
      });
    }

    this.initializeListeners();
    console.log('✅ Flux-Share Server initialized.');
  }
  
  /**
   * 清理已被逻辑删除的物理文件。
   * 这是一个开放给模块调用者的函数，可以定期调用或在服务关闭时调用。
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
        // 删除系统文件
        await fs.unlink(filePath);
        // 标记已经删除
        deleted.push(fileId);
      } catch (error: any) {
        // 如果文件不存在，也算作清理成功
        if (error.code === 'ENOENT') {
          deleted.push(fileId);
        } else {
          console.error(`Failed to delete file ${fileId}:`, error);
          failed.push(fileId);
        }
      }
    }
    
    // 从集合中移除已成功处理的项
    for (const fileId of deleted) {
      this.deletedFiles.delete(fileId);
    }

    console.log(`Cleanup finished. Deleted: ${deleted.length}, Failed: ${failed.length}.`);
    return { deleted, failed };
  }


  /**
   * 处理上传的数据，根据类型进行不同操作
   * @param data 客户端上传的原始数据
   * @returns 处理后的可存储/广播的数据，或在出错时返回 null
   */
  private async processUpload(data: TransferData): Promise<StoredData | null> {
    if (data.type === 'string') {
      return data; // 字符串直接返回
    }

    if (data.type === 'file') {
      // 1. 检查是否配置了上传目录
      if (!this.uploadDir) {
        console.error('File upload failed: uploadDir is not configured.');
        return null;
      }
      // 2. 校验文件大小
      if (data.content.length > this.maxFileSize) {
        console.error(`File upload failed: File size (${data.content.length} bytes) exceeds the limit of ${this.maxFileSize} bytes.`);
        return null;
      }

      const fileId = randomUUID();
      const filePath = path.join(this.uploadDir, fileId);

      try {
        // 3. 保存文件到目录
        await fs.writeFile(filePath, data.content);
        
        // 4. 构建要存储和广播的文件信息对象
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

    return null; // 未知类型
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
   * @param socket 客户端 Socket 实例
   */
  private handlePublicFlux(socket: Socket): void {
    socket.emit('public:history', this.publicHistory);

    socket.on('public:upload', async (data: TransferData) => {
      const processedData = await this.processUpload(data);
      if (!processedData) return; // 处理失败则不继续

      this.publicHistory.push(processedData);
      if (this.publicHistory.length > this.maxPublicHistory) {
        const removedItem = this.publicHistory.shift();
        // 如果移除的是文件，进行逻辑删除
        if (removedItem?.type === 'file') {
          this.deletedFiles.add(removedItem.fileId);
        }
      }
      this.io.emit('public:history', this.publicHistory);
    });

    socket.on('public:deleteLast', () => {
      if (this.publicHistory.length > 0) {
        const removedItem = this.publicHistory.pop();
        // 如果移除的是文件，进行逻辑删除
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

    socket.on('room:join', (roomId: string, callback: (response: { success: boolean; message: string; data?: StoredData }) => void) => {
      const room = this.rooms.get(roomId);
      if (!room) {
        return callback({ success: false, message: 'Room not found.' });
      }
      if (room.clients.size >= room.capacity) {
        return callback({ success: false, message: 'Room is full.' });
      }
      
      socket.join(roomId);
      room.clients.add(socket.id);

      let responseData: StoredData | undefined = undefined;
      if (room.mode === 'singleton' && room.data) {
        responseData = room.data;
      }
      
      console.log(`Client ${socket.id} joined room ${roomId}`);
      callback({ success: true, message: `Successfully joined room '${roomId}'.`, data: responseData });
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
        // 如果之前的数据是文件，先进行逻辑删除
        if (room.data?.type === 'file') {
            this.deletedFiles.add(room.data.fileId);
            console.log(`Logically deleted file due to overwrite: ${room.data.fileId}`);
        }
        room.data = processedData;
        this.io.to(roomId).emit('room:data', room.data);
      }
      callback({ success: true, message: 'Data sent successfully.' });
    });
  }
  
  public createPrivateRooms(options: RoomOptions): { success: boolean,roomId: string, message: string } {
    if (this.rooms.has(options.roomId)) {
      return { success: false,roomId: '' , message: `Room '${options.roomId}' already exists.` };
    }
    const newRoom: RoomData = {
      id: options.roomId,
      capacity: options.capacity,
      mode: options.mode,
      clients: new Set(),
      data: undefined,
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
          // 如果房间空了，并且是 singleton 模式且存有文件，则逻辑删除该文件
          if (room.mode === 'singleton' && room.data?.type === 'file') {
            this.deletedFiles.add(room.data.fileId);
            console.log(`Logically deleted file from empty room ${room.id}: ${room.data.fileId}`);
          }
          this.rooms.delete(room.id);
          console.log(`Room ${room.id} is empty and has been removed.`);
        }
      }
    });
  }
}