FROM node:26.11.1-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY patches ./patches
COPY packages/remote-relay ./packages/remote-relay
COPY packages/shared ./packages/shared
COPY packages/model-option-map ./packages/model-option-map
RUN pnpm install --frozen-lockfile --filter @zcode/remote-relay... --ignore-scripts
RUN pnpm --filter @zcode/remote-relay build
RUN mkdir -p /out/node_modules
# Resolve ws the way Node does instead of assuming a symlink path: pnpm may hoist or link it differently.
RUN cd packages/remote-relay && node -e "const {dirname}=require('node:path');const fs=require('node:fs');const src=dirname(require.resolve('ws/package.json'));fs.cpSync(fs.realpathSync(src),'/out/node_modules/ws',{recursive:true,dereference:true});"

FROM node:26.11.1-bookworm-slim
WORKDIR /app
COPY --from=build /workspace/packages/remote-relay/dist ./dist
COPY --from=build /out/node_modules ./node_modules
RUN mkdir /data && chown node:node /data
USER node
ENV ZCODE_RELAY_HOST=0.0.0.0 ZCODE_RELAY_PORT=3031 ZCODE_RELAY_DB_PATH=/data/relay.sqlite
EXPOSE 3031
# Railway 构建器不支持 VOLUME 指令；持久化卷需在 Railway 服务设置中挂载到 /data
CMD ["node", "dist/entry.js"]
