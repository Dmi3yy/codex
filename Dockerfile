# Use Ubuntu 24.04 with Node.js for GLIBC 2.39+ compatibility with Codex binary
FROM ubuntu:24.04

# Install system dependencies and Node.js
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    --no-install-recommends && \
    # Install Node.js 20.x
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install latest Codex CLI version (rust-v0.41.0)
RUN npm install -g @openai/codex@latest

# Create app directory
WORKDIR /app

# Copy package files first (for better Docker layer caching)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy server file
COPY server.js ./

# Create workspace and config directories with proper permissions
RUN mkdir -p /workspace /workspace/.config /workspace/.local/share && \
    chmod -R 755 /workspace

# Create non-root user for security
RUN addgroup --gid 1001 --system nodejs && \
    adduser --system --uid 1001 --gid 1001 nodejs

# Change ownership of workspace to nodejs user
RUN chown -R nodejs:nodejs /workspace /app

# Switch to non-root user
USER nodejs

# Environment variables
ENV PORT=8000
ENV WORKSPACE_ROOT=/workspace
ENV LOG_LEVEL=info
ENV NODE_ENV=production

# Expose HTTP port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run the HTTP server
CMD ["node", "server.js"]
