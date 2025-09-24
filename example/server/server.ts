import express from 'express';
import { createServer } from 'http'; // 明确从 http 模块导入
import path from 'path';
import { FluxShareServer } from '../../src/index'; // 引入你的模块

// 1. 创建 Express 应用
const app = express();

// 2. 创建一个 HTTP 服务器，并将 Express 应用作为请求处理器
const httpServer = createServer(app);

const fluxShareServer = new FluxShareServer(httpServer, { // 3. 将 httpServer 实例传入
  origin: '*', 
  uploadDir: './uploads',
});
// 使用 Express 托管前端静态文件 (user.html 和 agent.html)
// 假设你的 HTML 文件放在一个名为 'public' 的文件夹中
app.use(express.static(path.join(__dirname, 'public')));

// 文件下载支持
app.get('/files/:fileId', async (req, res) => { 
  const fileId = req.params.fileId;
  const filename = req.query.filename as string;

  res.download(path.join('./uploads', fileId), filename, (err) => {
    if (err) {
      console.error('Error downloading file:', err);
      res.status(404).send('File not found');
    }
  });
})

// 5. 启动服务器，监听 httpServer 而不是 app
const PORT = 3000;
httpServer.listen(PORT, () => {
  console.log(`✅ Express & FluxShare Server is running on http://localhost:${PORT}`);
});