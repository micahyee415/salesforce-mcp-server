# -- Stage 1: Build TypeScript --
FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# -- Stage 2: Production runtime --
FROM node:22-slim
WORKDIR /app

# Install only production dependencies (no TypeScript, no test tools)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript from build stage
COPY --from=builder /app/dist ./dist

# Run as non-root user (limits blast radius if container is compromised)
RUN groupadd -r app && useradd -r -g app -s /bin/false app
USER app

# Cloud Run sets PORT automatically (default 8080)
ENV PORT=8080
EXPOSE 8080

# Run the server — PORT env var triggers HTTP mode
CMD ["node", "dist/index.js"]
