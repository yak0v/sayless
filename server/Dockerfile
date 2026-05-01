FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates wget unzip && \
    # yt-dlp
    wget -qO /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && \
    chmod +x /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version && \
    # deno (yt-dlp uses it to solve YouTube's JS player challenges)
    wget -qO /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip && \
    unzip -q /tmp/deno.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/deno && \
    /usr/local/bin/deno --version && \
    rm /tmp/deno.zip && \
    apt-get purge -y --auto-remove unzip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .

ENV PORT=8787
EXPOSE 8787

USER node
CMD ["node", "server.js"]
