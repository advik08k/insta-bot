FROM node:20-bookworm-slim

# Install Python, pip, and ffmpeg for yt-dlp and instagrapi
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg curl && rm -rf /var/lib/apt/lists/*

# Alias python to python3 so child_process.exec('python ...') works
RUN ln -s /usr/bin/python3 /usr/bin/python || true

WORKDIR /app

# Install Python dependencies (instagrapi)
# We use --break-system-packages in modern pip inside Docker since it's an isolated environment
RUN pip3 install instagrapi --break-system-packages || pip3 install instagrapi

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the dashboard port
EXPOSE 3000

# Start the Node server
CMD ["node", "server.js"]
