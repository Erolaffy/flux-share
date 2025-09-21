# Flux-Share

![NPM Version](https://img.shields.io/npm/v/flux-share?color=blue)
![License](https://img.shields.io/badge/license-MIT-green)

**Flux-Share** 是一个为 Node.js 设计的、基于 WebSocket 的实时数据共享库。它允许你轻松地构建具有公共频道和私人加密房间的应用程序，非常适合在线剪切板、临时文件传输、实时协作等场景。所有数据均存储在内存中，无需数据库，启动即可使用。

## 特性

-   **公共频道**: 任何连接的客户端都可以访问的全局数据板。
-   **私人房间**: 需要创建和加入，具有用户容量限制。
-   **两种房间模式**:
    -   `singleton`: 房间只保留最新的一条数据，非常适合状态同步。
    -   `live`: 数据仅在成员间实时广播，服务器不存储，适合聊天或实时事件流。
-   **内存存储**: 无需配置数据库，快速且轻量。
-   **TypeScript 支持**: 使用 TypeScript 编写，提供完整的类型定义。
-   **易于集成**: 可以轻松附加到任何现有的 Node.js `http.Server`。
-   **大数据支持**: 默认支持最大 100MB 的数据传输，可用于文件分享。

## 安装

```bash
npm install flux-share socket.io
```

## 服务端使用

将 `FluxShareServer` 附加到一个标准的 Node.js `http.Server` 实例。下面是一个与 Express 结合的例子：

```typescript
// server.ts
import express from 'express';
import { createServer } from 'http';
import { FluxShareServer } from 'flux-share';

const app = express();
const httpServer = createServer(app);

// 实例化 FluxShareServer
const fluxShare = new FluxShareServer(httpServer, {
  maxPublicHistory: 100, // 可选：设置公共剪切板最大历史记录
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server is listening on port ${PORT}`);
});
```

## 客户端 API (使用 `socket.io-client`)

下面是客户端需要了解的所有事件。

### 连接

```javascript
import { io } from "socket.io-client";

const socket = io("http://localhost:3000");

socket.on("connect", () => {
  console.log("Connected to Flux-Share server!", socket.id);
});
```

### 公共剪切板事件

#### 监听事件

-   **`public:history`**: 当你连接成功或数据更新时，服务器会发送此事件，包含了整个公共剪切板的历史记录数组。
    ```javascript
    socket.on('public:history', (historyArray) => {
      console.log('Public history updated:', historyArray);
      // 更新你的 UI
    });
    ```

#### 发送事件

-   **`public:upload`**: 上传数据到公共剪切板。数据可以是任何可序列化的类型（字符串、对象、Buffer等）。
    ```javascript
    const myData = { text: 'Hello, world!', from: 'client-1' };
    socket.emit('public:upload', myData);

    // 发送文件 (Buffer)
    // const fileBuffer = ...;
    // socket.emit('public:upload', fileBuffer);
    ```
-   **`public:deleteLast`**: 请求服务器删除公共剪切板中的最后一条记录。
    ```javascript
    socket.emit('public:deleteLast');
    ```

### 私人房间事件

#### 发送事件

-   **`room:create`**: 创建一个新房间。
    ```javascript
    const roomOptions = {
      roomId: 'my-secret-room',
      capacity: 5,         // 最多5个成员
      mode: 'singleton'    // 'singleton' 或 'live'
    };

    socket.emit('room:create', roomOptions, (response) => {
      if (response.success) {
        console.log(response.message); // "Room 'my-secret-room' created successfully."
      } else {
        console.error(response.message);
      }
    });
    ```

-   **`room:join`**: 加入一个已存在的房间。
    ```javascript
    const roomId = 'my-secret-room';
    socket.emit('room:join', roomId, (response) => {
      if (response.success) {
        console.log(response.message); // "Successfully joined room 'my-secret-room'."
        if (response.data) {
          // 如果是 singleton 模式，这里会收到房间的当前数据
          console.log('Initial room data:', response.data);
        }
      } else {
        console.error(response.message); // "Room not found." 或 "Room is full."
      }
    });
    ```
-   **`room:upload`**: 在你已加入的房间中上传数据。
    ```javascript
    const payload = {
      roomId: 'my-secret-room',
      data: 'This is my secret message.'
    };
    socket.emit('room:upload', payload);
    ```

#### 监听事件

-   **`room:data`**: 监听来自你所在房间的数据更新。
    ```javascript
    socket.on('room:data', (data) => {
      console.log('Received new data from room:', data);
      // 更新你的 UI
    });
    ```

## 许可证

[MIT](./LICENSE)