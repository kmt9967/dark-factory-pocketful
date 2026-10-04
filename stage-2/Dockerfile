FROM node:22-alpine
WORKDIR /app
COPY server.js ./
ENV NODE_ENV=production PORT=8080 UV_THREADPOOL_SIZE=8
EXPOSE 8080
USER node
CMD ["node", "server.js"]
