FROM node:18-slim

WORKDIR /app

# First copy package files only to optimize Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Then copy the rest of the app
COPY . .

# Command to run the app
CMD ["node", "index.js"]