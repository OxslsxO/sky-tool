FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libreoffice-writer-nogui && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/node
WORKDIR /home/node/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

RUN mkdir -p backend/storage/models backend/storage/outputs backend/storage/temp /home/node/.sky-toolbox-runtime \
  && chown -R node:node /home/node/app /home/node/.sky-toolbox-runtime

RUN if [ ! -f backend/storage/models/u2net_human_seg.onnx ]; then \
    echo "Downloading backend/storage/models/u2net_human_seg.onnx..." \
    && curl -fSL -o backend/storage/models/u2net_human_seg.onnx "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx" \
    || echo "WARN: model download failed, will retry at runtime"; \
  fi

ENV PORT=7860
ENV HOST=0.0.0.0
ENV STORAGE_ROOT_DIR=/home/node/.sky-toolbox-runtime
EXPOSE 7860

USER node

CMD ["node", "backend/server.js"]
