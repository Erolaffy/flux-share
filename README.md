# FluxShare - Real-Time Data Sharing Library

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

FluxShare is a powerful backend library built on Node.js and Socket.io, designed to effortlessly implement real-time data sharing between clients. It supports both text strings and file transfers and provides a flexible room management system, including three distinct data persistence modes. Whether you're building an online collaboration tool, a real-time chat application, or a temporary file-sharing service, FluxShare provides the core functionality to accelerate your development process.

## ✨ Features

- **Public Broadcast Space**: A global space where all connected clients can share data. The server retains a configurable number of the most recent history items.
- **Private Rooms**: Create isolated rooms with specific capacities and modes for grouped communication.
- **Multiple Room Modes**:
    - `singleton`: The room only stores the most recent piece of data, with new data overwriting the old.
    - `live`: A pure real-time mode where data is only forwarded between clients, and the server keeps no records.
    - `history`: The room records all data sent within it until the room is closed.
- **File Upload & Management**: Supports file transfers with secure storage in a specified directory. Includes a cleanup mechanism to prevent disk space abuse.
- **Flexible Configuration**:
    - Customize the number of public history records.
    - Configure CORS origins to ensure secure connections.
    - Set a custom directory for uploads and a maximum file size.
- **Connection Authentication**: Supports an authentication hook for new connections to enhance security.
- **Logical Deletion & Cleanup**: Files are logically deleted when overwritten or when a room is closed, and can be physically purged using the `cleanupDeletedFiles` method.

## 🚀 Installation

```bash
npm install flux-share
```

## 🎬 Quick Start

Here is a basic example of how to set up the server:

```javascript
import { createServer } from 'http';
import { FluxShareServer } from 'flux-share';

// 1. Create a standard Node.js HTTP server
const httpServer = createServer();

// 2. Configure the FluxShareServer
const fluxShare = new FluxShareServer(httpServer, {
  // Allow connections from any origin
  origin: '*',
  // Set the directory for file uploads
  uploadDir: './uploads',
  // Keep the last 100 messages in the public space
  maxPublicHistory: 100,
  // Set the maximum file size to 50MB
  maxFileSize: 50 * 1024 * 1024,
  // (Optional) Add an authentication hook
  auth: (socket, next) => {
    console.log('New connection:', socket.id);
    next();
  }
});

// 3. Periodically clean up logically deleted files (e.g., every hour)
setInterval(() => {
  console.log('Running scheduled cleanup of deleted files...');
  fluxShare.cleanupDeletedFiles().then(result => {
    console.log(`Cleanup complete. Deleted: ${result.deleted.length}, Failed: ${result.failed.length}`);
  });
}, 3600 * 1000);


// 4. Start the server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
```

## 📚 API Documentation

### `new FluxShareServer(server, options)`

Creates a new `FluxShareServer` instance.

- `server`: An instance of Node.js's `http.Server`.
- `options` (optional): A `FluxShareOptions` configuration object.
    - `maxPublicHistory` (number): The maximum number of history records to keep for the public stream. Defaults to `50`.
    - `origin` (string | string[] | boolean): The allowed CORS origin(s). Defaults to `*`.
    - `uploadDir` (string): The storage directory for file uploads. If not provided, file uploads are disabled.
    - `maxFileSize` (number): The maximum allowed file size in bytes. Defaults to `100MB`.
    - `auth` (function): An authentication hook `(socket, next) => void`.

### `cleanupDeletedFiles(): Promise<{ deleted: string[], failed: string[] }>`

Asynchronously cleans up physically stored files in the `uploadDir` that have been logically deleted. Files are marked for deletion when a room is destroyed or when a file in a `singleton` room is overwritten. Call this method to free up disk space.

---

## 🔌 Client-Side Events

You can use the `socket.io-client` library to interact with the FluxShare server.

### Public Space Events

- **Receive History**:
  ```javascript
  socket.on('public:history', (history) => {
    // history is an array of StoredData objects
    console.log('Received public history:', history);
  });
  ```

- **Upload Data (String or File)**:
  ```javascript
  // Upload a string
  socket.emit('public:upload', { type: 'string', content: 'Hello, everyone!' });

  // Upload a file (example in a Node.js client)
  const fileBuffer = fs.readFileSync('path/to/your/file.png');
  socket.emit('public:upload', {
    type: 'file',
    content: fileBuffer,
    fileName: 'image.png',
    mimeType: 'image/png'
  });
  ```

- **Delete the Last Record**:
  ```javascript
  socket.emit('public:deleteLast');
  ```

### Private Room Events

- **Create a Room**:
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

- **Join a Room**:
  ```javascript
  socket.emit('room:join', 'my-private-room', (response) => {
    if (response.success) {
      console.log(response.message);
      // If the room is in 'singleton' or 'history' mode, response.data will contain the existing data.
      if (response.data) {
        console.log('Initial room data:', response.data);
      }
    } else {
      console.error(`Failed to join room: ${response.message}`);
    }
  });
  ```

- **Receive Room Data**:
  ```javascript
  socket.on('room:data', (data) => {
    // data is a StoredData object
    console.log('Received data from room:', data);
  });
  ```

- **Upload Data to a Room**:
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

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the issues page.

## 📄 License

This project is licensed under the [MIT](https://opensource.org/licenses/MIT) License.