FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY public/ ./public/

ENV PORT=3051
ENV DATA_FILE=/data/tokens.json
ENV BASE_URL=http://confirm.mesh

EXPOSE 3051
CMD ["node", "server.js"]
