# Import dry-run demo + mock API in one image (demo / acceptance use).
# Base image is MIT/BSD-licensed runtime. No GPL dependencies.
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .

RUN npm run build

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001 4173

CMD ["node", "server.js"]
