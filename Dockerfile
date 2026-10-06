FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV DB_PATH=/data/exam.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
