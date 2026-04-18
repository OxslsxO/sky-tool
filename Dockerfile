FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg libreoffice python3 python3-pip && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages pdf2docx

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN mkdir -p backend/storage/models \
  && node -e "const fs=require('fs');const{Readable}=require('stream');const{pipeline}=require('stream/promises');const url='https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx';(async()=>{const r=await fetch(url);if(!r.ok)throw new Error('model download failed: '+r.status);if(!r.body)throw new Error('model download failed: empty body');await pipeline(Readable.fromWeb(r.body),fs.createWriteStream('backend/storage/models/u2net_human_seg.onnx'));})().catch(e=>{console.error(e);process.exit(1);})"

COPY . .

ENV PORT=3100
EXPOSE 3100

CMD ["npm", "run", "backend:start"]
