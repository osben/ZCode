FROM node:24.14.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY patches ./patches
COPY packages/remote-relay ./packages/remote-relay
COPY packages/shared ./packages/shared
COPY packages/model-option-map ./packages/model-option-map
RUN pnpm install --frozen-lockfile --filter @zcode/remote-relay... --ignore-scripts
RUN pnpm --filter @zcode/remote-relay build
RUN mkdir -p /out/node_modules && cp -Lr packages/remote-relay/node_modules/ws /out/node_modules/ws

FROM node:24.14.0-bookworm-slim
WORKDIR /app
COPY --from=build /workspace/packages/remote-relay/dist ./dist
COPY --from=build /out/node_modules ./node_modules
RUN mkdir /data && chown node:node /data
USER node
ENV ZCODE_RELAY_HOST=0.0.0.0 ZCODE_RELAY_PORT=3031 ZCODE_RELAY_DB_PATH=/data/relay.sqlite
EXPOSE 3031
# Railway 构建器不支持 VOLUME 指令；持久化卷需在 Railway 服务设置中挂载到 /data
CMD ["node", "dist/entry.js"]
