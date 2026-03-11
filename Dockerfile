# Use Node 20 for better performance with modern JS features
FROM node:20-slim

# 1. Install FUSE 3 and CA Certificates
# FUSE is required to mount the buckets shown in your configuration.
RUN apt-get update && apt-get install -y \
    fuse3 \
    ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# 2. Create app directory
WORKDIR /usr/src/app

# 3. Create the mount points
# These MUST match the "Mount path" from your Cloud Run settings exactly.
RUN mkdir -p /video-app /edu_videos

# 4. Install dependencies
COPY package*.json ./
# We include --production to keep the image small
RUN npm install --production

# 5. Copy source code
# We no longer need to manually copy large video assets if they are in the bucket.
COPY . .

# 6. Set Environment Variables
ENV PORT=8080
ENV NODE_ENV=production

# 7. Start the application
# Cloud Run automatically mounts the volumes before this command executes.
CMD [ "node", "src/index.js" ]