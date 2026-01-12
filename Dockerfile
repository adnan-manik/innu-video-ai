FROM node:18-slim

# 1. Install FFmpeg and python3 (sometimes needed for specific node-gyp builds)
RUN apt-get update && apt-get install -y ffmpeg

# 2. Create app directory
WORKDIR /usr/src/app

# 3. Install dependencies
COPY package*.json ./
RUN npm install --only=production

# 4. Copy source code AND assets (intro/outro)
COPY . .

# 5. Start the worker
CMD [ "node", "src/index.js" ]