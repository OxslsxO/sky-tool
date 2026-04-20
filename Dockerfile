FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg libreoffice && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN mkdir -p backend/storage/models \
  && node -e "const fs=require('fs');const{Readable}=require('stream');const{pipeline}=require('stream/promises');const url='https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx';const download=async(retries=3)=>{for(let i=0;i<retries;i++){try{console.log('Downloading model (attempt '+(i+1)+'/'+retries+')...');const r=await fetch(url,{signal:AbortSignal.timeout(300000)});if(!r.ok)throw new Error('model download failed: '+r.status);if(!r.body)throw new Error('model download failed: empty body');await pipeline(Readable.fromWeb(r.body),fs.createWriteStream('backend/storage/models/u2net_human_seg.onnx'));console.log('Model downloaded successfully');return;}catch(e){console.error('Attempt '+(i+1)+' failed:',e.message);if(i===retries-1)throw e;await new Promise(r=>setTimeout(r,5000));}}};download().catch(e=>{console.error(e);process.exit(1)});"

COPY . .

ENV PORT=3100
EXPOSE 3100

CMD ["npm", "run", "backend:start"]
