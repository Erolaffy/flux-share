# FluxShare - 实时数据共享库

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FluxShare 是一个基于 Node.js 和 Socket.io 构建的强大后端库，旨在轻松实现客户端之间的实时数据共享。它支持文本字符串和文件传输，并提供灵活的房间管理机制，包括三种不同的数据持久化模式。无论您是想构建一个在线协作工具、一个实时聊天应用，还是一个临时文件分享服务，FluxShare 都提供了核心功能来加速您的开发进程。

## ✨ 功能特性

- **公共广播空间**: 提供一个全局空间，所有连接的客户端都可以在此共享数据。
- **私有房间**: 允许创建特定容量和模式的独立房间，实现分组隔离通信。
- **多种房间模式**:
    - `singleton`: 房间只保留最新的一份数据，新数据会覆盖旧数据。
    - `live`: 纯实时模式，数据仅在客户端之间转发，服务器不保留任何记录。
    - `history`: 历史模式，房间会记录所有被发送的数据，直到房间关闭。
- **文件上传与管理**: 支持文件传输，并能安全地存储在服务器指定目录。同时提供文件清理机制。
- **灵活的配置**:
    - 自定义公共历史记录数量。
    - 配置CORS来源，确保连接安全。
    - 自定义文件上传目录和最大文件大小。
- **连接认证**: 支持通过钩子函数对新连接进行身份验证，增强安全性。
- **逻辑删除与清理**: 当文件被覆盖或房间关闭时，文件会被逻辑删除，可通过 `cleanupDeletedFiles` 方法进行物理删除。

## 🚀 安装

```bash
npm install flux-share
```

## 🎬 快速开始

以下是一个基本的服务器设置示例：

```javascript
import { createServer } from 'http';
import { FluxShareServer } from 'flux-share';

// 1. 创建一个标准的 HTTP 服务器
const httpServer = createServer();

// 2. 配置 FluxShareServer
const fluxShare = new FluxShareServer(httpServer, {
  // 允许所有来源的连接
  origin: '*',
  // 设置文件上传的存储目录
  uploadDir: './uploads',
  // 公共空间最多保留 100 条历史记录
  maxPublicHistory: 100,
  // 允许上传的最大文件大小为 50MB
  maxFileSize: 50 * 1024 * 1024,
  // (可选) 添加连接认证
  auth: (socket, next) => {
    console.log(`New connection from ${socket.handshake.address}`);
    next();
  }
});

// 3. 定期清理已删除的文件 (例如：每小时)
setInterval(() => {
  console.log('Running scheduled cleanup of deleted files...');
  fluxShare.cleanupDeletedFiles().then(result => {
    console.log(`Cleanup complete. Deleted: ${result.deleted.length}, Failed: ${result.failed.length}`);
  });
}, 3600 * 1000);


// 4. 启动服务器
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
```

## 📚 API 文档

### `new FluxShareServer(server, options)`

创建 `FluxShareServer` 实例。

- `server`: 一个 Node.js `http.Server` 实例。
- `options` (可选): 一个配置对象 `FluxShareOptions`。
    - `maxPublicHistory` (number): 公共流保留的历史记录最大数量。默认为 `50`。
    - `origin` (string | string[] | boolean): 允许的 CORS 来源。默认为 `*`。
    - `uploadDir` (string): 文件上传的存储目录。若不提供，则不支持文件上传。
    - `maxFileSize` (number): 允许上传的最大文件大小（字节）。默认为 `100MB`。
    - `auth` (function): 连接校验钩子函数 `(socket, next) => void`。

### `cleanupDeletedFiles(): Promise<{ deleted: string[], failed: string[] }>`

异步清理在 `uploadDir` 目录中被逻辑删除的物理文件。当房间被销毁或文件被覆盖时，相关文件会被标记为逻辑删除。调用此方法可以释放磁盘空间。

---

## 🔌 客户端事件 (Client-Side)

您可以使用 `socket.io-client` 与 FluxShare 服务器进行交互。

### 公共空间事件 (Public Space)

- **接收历史记录**:
  ```javascript
  socket.on('public:history', (history) => {
    // history 是一个 StoredData[] 数组
    console.log('Received public history:', history);
  });
  ```

- **上传数据 (字符串或文件)**:
  ```javascript
  // 上传字符串
  socket.emit('public:upload', { type: 'string', content: 'Hello, everyone!' });

  // 上传文件 (在 Node.js 客户端)
  const fileBuffer = fs.readFileSync('path/to/your/file.png');
  socket.emit('public:upload', {
    type: 'file',
    content: fileBuffer,
    fileName: 'file.png',
    mimeType: 'image/png'
  });
  ```

- **删除最后一条记录**:
  ```javascript
  socket.emit('public:deleteLast');
  ```

### 私有房间事件 (Private Rooms)

- **创建房间**:
  ```javascript
  const roomOptions = {
    roomId: 'my-private-room',
    capacity: 10,
    mode: 'history' // 'singleton', 'live', or 'history'
  };
  socket.emit('room:create', roomOptions, (response) => {
    if (response.success) {
      console.log(`Room created with ID: ${response.roomId}`);
    } else {
      console.error(`Failed to create room: ${response.message}`);
    }
  });
  ```

- **加入房间**:
  ```javascript
  socket.emit('room:join', 'my-private-room', (response) => {
    if (response.success) {
      console.log(response.message);
      // 如果房间是 singleton 或 history 模式，response.data 会包含现有数据
      if (response.data) {
        console.log('Initial room data:', response.data);
      }
    } else {
      console.error(`Failed to join room: ${response.message}`);
    }
  });
  ```

- **接收房间数据**:
  ```javascript
  socket.on('room:data', (data) => {
    // data 是一个 StoredData 对象
    console.log('Received data from room:', data);
  });
  ```

- **在房间内上传数据**:
  ```javascript
  const payload = {
    roomId: 'my-private-room',
    data: {
      type: 'string',
      content: 'This is a message for the room.'
    }
  };
  socket.emit('room:upload', payload, (response) => {
    if (response.success) {
      console.log('Data sent successfully.');
    } else {
      console.error(`Failed to send data: ${response.message}`);
    }
  });
  ```

## 🤝 贡献

欢迎提交问题 (issues) 和拉取请求 (pull requests)！

## 📄 许可证

本项目采用 [MIT](https://opensource.org/licenses/MIT) 许可证。