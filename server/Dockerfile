# 中国象棋联机中继镜像（零第三方依赖，仅 Node 标准库）
# 构建：docker build -t chess-room ./server
# 运行：docker run -d --name chess-room --restart unless-stopped -p 127.0.0.1:8787:8787 chess-room
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

# 仅复制运行所需两个文件，镜像层最小且构建缓存友好
COPY relay.js room-server.js ./

# 以非 root 用户运行（node 镜像自带 node 用户）
USER node

EXPOSE 8787

CMD ["node", "room-server.js"]
