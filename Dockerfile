# Connect — zero-dependency chat server.
# Build:  docker build -t connect-chat .
# Run:    docker run -p 3000:3000 connect-chat
FROM node:20-alpine

WORKDIR /app

# Only the files the app actually needs — no node_modules, because there are none.
COPY package.json server.js ./
COPY lib ./lib/
COPY public ./public/

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

USER node

CMD ["node", "server.js"]
