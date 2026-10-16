import { defineConfig } from 'vite';
import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { resolve, sep } from 'node:path';

export default defineConfig({
  root: 'client',
  base: '/',
  define: { 'process.env.IS_PREACT': 'false' }, // 官方组件依赖此编译常量。
  build: { outDir: '../dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  plugins: [{
    name: 'excalidraw-local-fonts',
    configureServer(server) {
      const fonts = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');
      server.middlewares.use('/excalidraw-assets/fonts', (request, response, next) => {
        let relative;
        try { relative = decodeURIComponent((request.url || '').split('?')[0]); } catch { return next(); }
        const path = resolve(fonts, `.${relative}`);
        if (!path.startsWith(`${fonts}${sep}`) || !path.endsWith('.woff2') || !existsSync(path)) return next();
        response.setHeader('Content-Type', 'font/woff2');
        createReadStream(path).pipe(response);
      });
    },
    closeBundle() {
      // 字体随站点部署，避免嵌入页依赖外部 CDN。
      cpSync('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'dist/excalidraw-assets/fonts', { recursive: true });
      // 构建时压缩，避免首次访问占用服务器CPU。
      for (const name of readdirSync('dist/assets').filter(name => /\.(js|css)$/.test(name))) {
        const file = `dist/assets/${name}`, bytes = readFileSync(file);
        writeFileSync(`${file}.br`, brotliCompressSync(bytes)); writeFileSync(`${file}.gz`, gzipSync(bytes));
      }
    },
  }],
});
