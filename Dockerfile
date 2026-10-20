FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
USER node
ENV HOST=0.0.0.0 PORT=8082 STATE_DIRECTORY=/app/data NODE_ENV=production
EXPOSE 8082
CMD ["node", "--use-env-proxy", "server/index.mjs"]
