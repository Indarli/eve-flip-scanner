FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# внутри контейнера слушаем все интерфейсы; наружу публикуйте только на 127.0.0.1
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package.json ./
COPY server.mjs cli-scan.mjs ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "server.mjs"]
