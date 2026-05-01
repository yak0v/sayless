FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates wget && \
    wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && \
    chmod +x /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .

ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "server.js"]
